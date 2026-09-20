const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');

const app = express();

app.use(express.json({ limit: '15mb' }));
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://pyus1528_db_user:qG3feuciLBXuBciS@manit-mess.y5xx5ki.mongodb.net/manitMessDB?retryWrites=true&w=majority&appName=Manit-Mess';

mongoose.connect(MONGO_URI, {
    maxPoolSize: 50,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000
}).then(() => {
    console.log("✅ MongoDB Atlas Cloud Connected Successfully");
    seedWhitelistedStudents();
}).catch(err => console.error("❌ MongoDB Atlas Connection Error:", err));

// Whitelist of pre-authorized students
const WHITELISTED_IDS = [
    { scholarId: '260111011249', name: 'Authorized Student 1', room: 'Hostel 10' },
    { scholarId: '260111011250', name: 'Authorized Student 2', room: 'Hostel 10' },
    { scholarId: '260111011251', name: 'Authorized Student 3', room: 'Hostel 10' }
];

const studentSchema = new mongoose.Schema({
    scholarId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    room: { type: String, required: true },
    password: { type: String, default: null },
    photo: { type: String, default: null },
    isRegistered: { type: Boolean, default: false },
    lastClaimedMeal: { type: String, default: '' }
}, { timestamps: true });

const Student = mongoose.model('Student', studentSchema);

// Auto-seed the 3 allowed IDs on startup if they don't already exist
async function seedWhitelistedStudents() {
    try {
        for (const item of WHITELISTED_IDS) {
            const exists = await Student.findOne({ scholarId: item.scholarId });
            if (!exists) {
                await Student.create({
                    scholarId: item.scholarId,
                    name: item.name,
                    room: item.room,
                    isRegistered: false
                });
                console.log(`Initialized whitelist ID: ${item.scholarId}`);
            }
        }
    } catch (e) {
        console.error("Whitelist seed error:", e);
    }
}

// Automated Scheduling Logic with fallback
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

// 1. Register / Activate (Enforces Whitelist)
app.post('/api/register', async (req, res) => {
    try {
        const { scholarId, name, room, password, photo } = req.body;
        if (!scholarId || !password || !photo) {
            return res.status(400).json({ success: false, message: "Scholar ID, photo, and password are required." });
        }

        const cleanId = scholarId.trim();

        // 1. Look up student in whitelist records
        const student = await Student.findOne({ scholarId: cleanId });
        if (!student) {
            return res.status(403).json({ 
                success: false, 
                message: "Unauthorized: Scholar ID not found on Hostel 10 master records." 
            });
        }

        // 2. Prevent duplicate registrations / identity spoofing
        if (student.isRegistered) {
            return res.status(409).json({ 
                success: false, 
                message: "This Scholar ID has already been registered! Please log in." 
            });
        }

        // 3. Activate account
        student.name = name && name.trim() ? name.trim() : student.name;
        student.room = room && room.trim() ? room.trim() : student.room;
        student.password = password;
        student.photo = photo;
        student.isRegistered = true;
        await student.save();

        res.status(201).json({ success: true, message: "ID Card registered and activated successfully!" });
    } catch (err) {
        console.error("Register Error:", err);
        res.status(500).json({ success: false, message: "Registration error." });
    }
});

// 2. Login
app.post('/api/login', async (req, res) => {
    try {
        const { scholarId, password } = req.body;
        const student = await Student.findOne({ scholarId: scholarId.trim(), password }).lean();
        if (student && student.isRegistered) {
            res.json({ success: true, student: { scholarId: student.scholarId, name: student.name, room: student.room, photo: student.photo } });
        } else if (student && !student.isRegistered) {
            res.status(401).json({ success: false, message: "Card not registered yet. Please click 'Register Card' first." });
        } else {
            res.status(401).json({ success: false, message: "Invalid credentials." });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: "Login error." });
    }
});

// 3. Status Poll
app.get('/api/status/:scholarId', async (req, res) => {
    try {
        const slot = getCurrentMealSlot();
        const student = await Student.findOne({ scholarId: req.params.scholarId.trim() }).lean();
        if (!student || !student.isRegistered) return res.json({ activeSlot: slot.name, claimed: false });

        const hasClaimed = (student.lastClaimedMeal === slot.id);
        res.json({ activeSlot: slot.name, claimed: hasClaimed });
    } catch (err) {
        res.status(500).json({ error: "Check failed" });
    }
});

// 4. Scanner Endpoint
app.post('/api/scan', async (req, res) => {
    try {
        const cleanId = req.body.scholarId.trim();
        const slot = getCurrentMealSlot();

        const claimed = await Student.findOneAndUpdate(
            { scholarId: cleanId, isRegistered: true, lastClaimedMeal: { $ne: slot.id } },
            { $set: { lastClaimedMeal: slot.id } },
            { new: true }
        ).lean();

        if (claimed) {
            return res.json({ status: 'allowed', name: claimed.name, room: claimed.room });
        }

        const existing = await Student.findOne({ scholarId: cleanId }).lean();
        if (!existing || !existing.isRegistered) return res.json({ status: 'error', message: "Unregistered or Invalid ID Card" });

        return res.json({ status: 'denied', name: existing.name, room: existing.room });
    } catch (err) {
        res.status(500).json({ status: 'error', message: "Scan error." });
    }
});

// 5. Manual Reset - Single Student
app.post('/api/reset-one', async (req, res) => {
    try {
        const { scholarId, staffPin } = req.body;
        if (staffPin !== 'manitH10') return res.status(403).json({ success: false, message: "Unauthorized PIN" });

        const updated = await Student.findOneAndUpdate(
            { scholarId: scholarId.trim() },
            { $set: { lastClaimedMeal: '' } }
        );

        if (!updated) return res.status(404).json({ success: false, message: "Scholar ID not found" });
        res.json({ success: true, message: `Reset successful for Scholar ID: ${scholarId}` });
    } catch (err) {
        res.status(500).json({ success: false, message: "Reset failed" });
    }
});

// 6. Manual Reset - All Students
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
app.listen(PORT, () => console.log(`🚀 Production server listening on port ${PORT}`));
