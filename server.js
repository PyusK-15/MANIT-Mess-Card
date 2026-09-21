const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const nodemailer = require('nodemailer');

const app = express();

app.use(express.json({ limit: '15mb' }));
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://pyus1528_db_user:qG3feuciLBXuBciS@manit-mess.y5xx5ki.mongodb.net/manitMessDB?retryWrites=true&w=majority&appName=Manit-Mess';

// Dual SMTP Transporters on Port 465 (Vercel allows 465)
const transporters = [
    nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: {
            user: process.env.EMAIL_1 ? process.env.EMAIL_1.trim() : '',
            pass: process.env.PASS_1 ? process.env.PASS_1.replace(/\s+/g, '') : ''
        },
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 15000
    }),
    nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: {
            user: process.env.EMAIL_2 ? process.env.EMAIL_2.trim() : '',
            pass: process.env.PASS_2 ? process.env.PASS_2.replace(/\s+/g, '') : ''
        },
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 15000
    })
];
let currentTransporterIndex = 0;

mongoose.connect(MONGO_URI, {
    maxPoolSize: 15, // Optimized for serverless
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000
}).then(() => console.log("✅ MongoDB Atlas Connected"))
  .catch(err => console.error("❌ MongoDB Connection Error:", err));

const studentSchema = new mongoose.Schema({
    scholarId: { type: String, required: true, unique: true, index: true },
    collegeEmail: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    room: { type: String, required: true },
    password: { type: String, required: true },
    photo: { type: String, required: true },
    lastClaimedMeal: { type: String, default: '' }
}, { timestamps: true });

const Student = mongoose.model('Student', studentSchema);

const otpSchema = new mongoose.Schema({
    scholarId: { type: String, required: true, index: true },
    otp: { type: String, required: true },
    createdAt: { type: Date, default: Date.now, expires: 600 }
});
const OtpRecord = mongoose.model('OtpRecord', otpSchema);

function getCurrentMealSlot() {
    const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const hh = d.getHours().toString().padStart(2, '0');
    const mm = d.getMinutes().toString().padStart(2, '0');
    const timeStr = `${hh}:${mm}`;
    const dateStr = `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`;

    let mealSlot = "Mess Service";
    if (timeStr >= "07:30" && timeStr < "11:00") mealSlot = "Breakfast";
    else if (timeStr >= "12:30" && timeStr < "15:30") mealSlot = "Lunch";
    else if (timeStr >= "17:00" && timeStr < "18:30") mealSlot = "Snacks";
    else if (timeStr >= "19:30" && timeStr < "22:30") mealSlot = "Dinner";
    else mealSlot = "Special / Off-Peak Service";

    return { active: true, id: `${dateStr}-${mealSlot}`, name: mealSlot };
}

// 1. Request OTP (Alternating Mailers to bypass limits)
app.post('/api/request-otp', async (req, res) => {
    try {
        const { scholarId } = req.body;
        if (!scholarId) return res.status(400).json({ success: false, message: "Enter Scholar ID" });

        const cleanId = scholarId.trim().toLowerCase();
        const collegeEmail = `${cleanId}@stu.manit.ac.in`;

        const existing = await Student.findOne({ scholarId: cleanId });
        if (existing) {
            return res.status(409).json({ success: false, message: "Account already exists for this Scholar ID. Please log in." });
        }

        const otp = Math.floor(100000 + Math.random() * 900000).toString();

        await OtpRecord.deleteMany({ scholarId: cleanId });
        await OtpRecord.create({ scholarId: cleanId, otp });

        const activeTransporter = transporters[currentTransporterIndex];
        currentTransporterIndex = (currentTransporterIndex + 1) % transporters.length;

        const mailOptions = {
            from: `"MANIT Hostel Mess Portal" <${activeTransporter.options.auth.user}>`,
            to: collegeEmail,
            subject: `MANIT Mess Registration OTP: ${otp}`,
            html: `
                <div style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #e2e8f0; border-radius: 10px; max-width: 500px;">
                    <h2 style="color: #0a2540;">MANIT Hostel Digital Identity Pass</h2>
                    <p>You requested registration for the Hostel Digital Mess Card using Scholar ID: <strong>${cleanId}</strong>.</p>
                    <div style="background: #f1f5f9; padding: 15px; border-radius: 8px; text-align: center; margin: 20px 0;">
                        <span style="font-size: 26px; font-weight: 800; letter-spacing: 5px; color: #2563eb;">${otp}</span>
                    </div>
                    <p style="font-size: 12px; color: #64748b;">This OTP will expire in 10 minutes. If you did not request this, please disregard this email.</p>
                </div>
            `
        };

        await activeTransporter.sendMail(mailOptions);
        console.log(`[OTP DISPATCHED] Scholar: ${cleanId} | Route: Account ${currentTransporterIndex}`);
        res.json({ success: true, message: `OTP sent to ${collegeEmail}` });
    } catch (err) {
        console.error("OTP Error:", err);
        res.status(500).json({ 
            success: false, 
            message: `Mailer Error: ${err.message || "Failed to dispatch OTP"}` 
        });
    }
});

// 2. Verify OTP and Register
app.post('/api/verify-and-register', async (req, res) => {
    try {
        const { scholarId, otp, name, room, password, photo } = req.body;
        if (!scholarId || !otp || !name || !room || !password || !photo) {
            return res.status(400).json({ success: false, message: "All fields are required." });
        }

        const cleanId = scholarId.trim().toLowerCase();
        const validOtp = await OtpRecord.findOne({ scholarId: cleanId, otp: otp.trim() });

        if (!validOtp) {
            return res.status(400).json({ success: false, message: "Invalid or expired OTP. Please try again." });
        }

        const collegeEmail = `${cleanId}@stu.manit.ac.in`;
        const newStudent = new Student({
            scholarId: cleanId,
            collegeEmail,
            name: name.trim(),
            room: room.trim(),
            password,
            photo
        });

        await newStudent.save();
        await OtpRecord.deleteMany({ scholarId: cleanId });

        res.status(201).json({ success: true, message: "Registration successful! You can now log in." });
    } catch (err) {
        console.error("Registration Error:", err);
        res.status(500).json({ success: false, message: "Registration failed." });
    }
});

// 3. Login
app.post('/api/login', async (req, res) => {
    try {
        const { scholarId, password } = req.body;
        const student = await Student.findOne({ scholarId: scholarId.trim().toLowerCase(), password }).lean();
        if (student) {
            res.json({ success: true, student: { scholarId: student.scholarId, name: student.name, room: student.room, photo: student.photo } });
        } else {
            res.status(401).json({ success: false, message: "Invalid Scholar ID or password." });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: "Login error." });
    }
});

// 4. Status Poll
app.get('/api/status/:scholarId', async (req, res) => {
    try {
        const slot = getCurrentMealSlot();
        const student = await Student.findOne({ scholarId: req.params.scholarId.trim().toLowerCase() }).lean();
        if (!student) return res.json({ activeSlot: slot.name, claimed: false });

        const hasClaimed = (student.lastClaimedMeal === slot.id);
        res.json({ activeSlot: slot.name, claimed: hasClaimed });
    } catch (err) {
        res.status(500).json({ error: "Check failed" });
    }
});

// 5. Staff Counter Scan
app.post('/api/scan', async (req, res) => {
    try {
        const cleanId = req.body.scholarId.trim().toLowerCase();
        const slot = getCurrentMealSlot();

        const claimed = await Student.findOneAndUpdate(
            { scholarId: cleanId, lastClaimedMeal: { $ne: slot.id } },
            { $set: { lastClaimedMeal: slot.id } },
            { new: true }
        ).lean();

        if (claimed) {
            return res.json({ status: 'allowed', name: claimed.name, room: claimed.room });
        }

        const existing = await Student.findOne({ scholarId: cleanId }).lean();
        if (!existing) return res.json({ status: 'error', message: "Unregistered Scholar ID" });

        return res.json({ status: 'denied', name: existing.name, room: existing.room });
    } catch (err) {
        res.status(500).json({ status: 'error', message: "Scan processing error." });
    }
});

// 6. Manual Reset Endpoints
app.post('/api/reset-one', async (req, res) => {
    try {
        const { scholarId, staffPin } = req.body;
        if (staffPin !== 'manitH10') return res.status(403).json({ success: false, message: "Unauthorized PIN" });

        const updated = await Student.findOneAndUpdate(
            { scholarId: scholarId.trim().toLowerCase() },
            { $set: { lastClaimedMeal: '' } }
        );

        if (!updated) return res.status(404).json({ success: false, message: "Scholar ID not found" });
        res.json({ success: true, message: `Reset successful for Scholar ID: ${scholarId}` });
    } catch (err) {
        res.status(500).json({ success: false, message: "Reset failed" });
    }
});

app.post('/api/reset-all', async (req, res) => {
    try {
        const { staffPin } = req.body;
        if (staffPin !== 'manitH10') return res.status(403).json({ success: false, message: "Unauthorized PIN" });

        await Student.updateMany({}, { $set: { lastClaimedMeal: '' } });
        res.json({ success: true, message: "All student cards reset successfully!" });
    } catch (err) {
        res.status(500).json({ success: false, message: "Reset all failed" });
    }
});

// Vercel Serverless Export
if (process.env.VERCEL) {
    module.exports = app;
} else {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`🚀 Production server listening on port ${PORT}`));
}
