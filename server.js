const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');

const app = express();

app.use(express.json({ limit: '15mb' }));
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://pyus1528_db_user:qG3feuciLBXuBciS@manit-mess.y5xx5ki.mongodb.net/manitMessDB?retryWrites=true&w=majority';

mongoose.connect(MONGO_URI, {
    maxPoolSize: 50,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000
}).then(() => console.log("✅ MongoDB Atlas Connected Successfully"))
  .catch(err => console.error("❌ MongoDB Connection Error:", err.message));

const studentSchema = new mongoose.Schema({
    scholarId: { type: String, required: true, unique: true, index: true },
    collegeEmail: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    room: { type: String, required: true },
    password: { type: String, required: true },
    photo: { type: String, required: true },
    isVerified: { type: Boolean, default: false }, // Staff verifies on Day 1
    lastClaimedMeal: { type: String, default: '' }
}, { timestamps: true });

const Student = mongoose.model('Student', studentSchema);

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

// 1. Instant Registration (No OTP / Zero Email Blockers)
app.post('/api/register', async (req, res) => {
    try {
        const { scholarId, name, room, password, photo } = req.body;
        if (!scholarId || !name || !room || !password || !photo) {
            return res.status(400).json({ success: false, message: "All fields are required." });
        }

        const cleanId = scholarId.trim().toLowerCase();
        const existing = await Student.findOne({ scholarId: cleanId });
        if (existing) {
            return res.status(409).json({ success: false, message: "Account already exists for this Scholar ID. Please log in." });
        }

        const newStudent = new Student({
            scholarId: cleanId,
            collegeEmail: `${cleanId}@stu.manit.ac.in`,
            name: name.trim(),
            room: room.trim(),
            password,
            photo,
            isVerified: false
        });

        await newStudent.save();
        res.status(201).json({ success: true, message: "Account created! Present physical MANIT ID at the mess for first-time activation." });
    } catch (err) {
        console.error("Registration Error:", err);
        res.status(500).json({ success: false, message: "Registration failed." });
    }
});

// 2. Student Login
app.post('/api/login', async (req, res) => {
    try {
        const { scholarId, password } = req.body;
        const student = await Student.findOne({ scholarId: scholarId.trim().toLowerCase(), password }).lean();
        if (student) {
            res.json({ 
                success: true, 
                student: { 
                    scholarId: student.scholarId, 
                    name: student.name, 
                    room: student.room, 
                    photo: student.photo,
                    isVerified: student.isVerified 
                } 
            });
        } else {
            res.status(401).json({ success: false, message: "Invalid Scholar ID or password." });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: "Login error." });
    }
});

// 3. Status Poll
app.get('/api/status/:scholarId', async (req, res) => {
    try {
        const slot = getCurrentMealSlot();
        const student = await Student.findOne({ scholarId: req.params.scholarId.trim().toLowerCase() }).lean();
        if (!student) return res.json({ activeSlot: slot.name, claimed: false, isVerified: false });

        const hasClaimed = (student.lastClaimedMeal === slot.id);
        res.json({ activeSlot: slot.name, claimed: hasClaimed, isVerified: student.isVerified });
    } catch (err) {
        res.status(500).json({ error: "Check failed" });
    }
});

// 4. Staff Counter Scanner (Checks Meal & Auto-Activates Unverified Cards)
app.post('/api/scan', async (req, res) => {
    try {
        const cleanId = req.body.scholarId.trim().toLowerCase();
        const slot = getCurrentMealSlot();

        const student = await Student.findOne({ scholarId: cleanId });
        if (!student) return res.json({ status: 'error', message: "Unregistered Student" });

        // If it's student's first time, activate their card after physical check
        let justActivated = false;
        if (!student.isVerified) {
            student.isVerified = true;
            justActivated = true;
        }

        if (student.lastClaimedMeal === slot.id) {
            return res.json({ status: 'denied', name: student.name, room: student.room });
        }

        student.lastClaimedMeal = slot.id;
        await student.save();

        return res.json({ 
            status: 'allowed', 
            name: student.name, 
            room: student.room,
            activated: justActivated 
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: "Scan processing error." });
    }
});

// 5. Staff Card Resets
app.post('/api/reset-one', async (req, res) => {
    try {
        const { scholarId, staffPin } = req.body;
        if (staffPin !== 'manitH10') return res.status(403).json({ success: false, message: "Unauthorized PIN" });

        const updated = await Student.findOneAndUpdate(
            { scholarId: scholarId.trim().toLowerCase() },
            { $set: { lastClaimedMeal: '' } }
        );

        if (!updated) return res.status(404).json({ success: false, message: "Scholar ID not found" });
        res.json({ success: true, message: `Reset complete for ${scholarId}` });
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Production server live on port ${PORT}`));
