const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');

const app = express();

app.use(express.json({ limit: '10mb' }));
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://pyus1528_db_user:qG3feuciLBXuBciS@manit-mess.y5xx5ki.mongodb.net/manitMessDB?retryWrites=true&w=majority&appName=Manit-Mess';

mongoose.connect(MONGO_URI, {
    maxPoolSize: 50,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000
}).then(() => console.log("✅ MongoDB Atlas Cloud Connected Successfully"))
  .catch(err => console.error("❌ MongoDB Atlas Connection Error:", err));

// Schema Update: We now track the specific meal period claimed, not just true/false
const studentSchema = new mongoose.Schema({
    scholarId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    room: { type: String, required: true },
    password: { type: String, required: true },
    photo: { type: String, required: true },
    lastClaimedMeal: { type: String, default: '' } // e.g., "2026-09-20-Breakfast"
}, { timestamps: true });

const Student = mongoose.model('Student', studentSchema);

// --- AUTOMATED SCHEDULING LOGIC (Indian Standard Time) ---
function getCurrentMealSlot() {
    // Force IST Time calculation so it works correctly on cloud servers
    const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const hh = d.getHours().toString().padStart(2, '0');
    const mm = d.getMinutes().toString().padStart(2, '0');
    const timeStr = `${hh}:${mm}`;
    const dateStr = `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`;

    let mealSlot = "None";
    // Timings logic (24-hour format)
    if (timeStr >= "07:30" && timeStr < "11:00") mealSlot = "Breakfast";
    else if (timeStr >= "12:30" && timeStr < "15:30") mealSlot = "Lunch";
    else if (timeStr >= "17:00" && timeStr < "18:30") mealSlot = "Snacks";
    else if (timeStr >= "19:30" && timeStr < "22:30") mealSlot = "Dinner";
    // Test slot for debugging outside meal hours:
    // else mealSlot = "TestMeal"; 

    if (mealSlot === "None") return { active: false, id: null, name: "None" };
    return { active: true, id: `${dateStr}-${mealSlot}`, name: mealSlot };
}

// --- API ROUTES ---

// 1. Registration
app.post('/api/register', async (req, res) => {
    try {
        const { scholarId, name, room, password, photo } = req.body;
        if (!scholarId || !name || !room || !password || !photo) {
            return res.status(400).json({ success: false, message: "All mandatory fields including photo must be provided." });
        }

        const cleanId = scholarId.trim();
        const existingStudent = await Student.findOne({ scholarId: cleanId });
        if (existingStudent) return res.status(409).json({ success: false, message: "Scholar ID already registered!" });

        const newStudent = new Student({ scholarId: cleanId, name: name.trim(), room: room.trim(), password, photo });
        await newStudent.save();
        res.status(201).json({ success: true, message: "ID Card registered successfully! Please log in." });
    } catch (err) {
        res.status(500).json({ success: false, message: "Server error during registration." });
    }
});

// 2. Login
app.post('/api/login', async (req, res) => {
    try {
        const { scholarId, password } = req.body;
        const student = await Student.findOne({ scholarId: scholarId.trim(), password }).lean();
        if (student) {
            res.json({ success: true, student: { scholarId: student.scholarId, name: student.name, room: student.room, photo: student.photo } });
        } else {
            res.status(401).json({ success: false, message: "Invalid Scholar ID or Password." });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: "Server error during login." });
    }
});

// 3. Status Polling (Frontend asks: "Is my QR code still valid?")
app.get('/api/status/:scholarId', async (req, res) => {
    try {
        const slot = getCurrentMealSlot();
        if (!slot.active) return res.json({ activeSlot: "None", claimed: false });

        const student = await Student.findOne({ scholarId: req.params.scholarId }).lean();
        if (!student) return res.json({ activeSlot: slot.name, claimed: false });

        const hasClaimed = (student.lastClaimedMeal === slot.id);
        res.json({ activeSlot: slot.name, claimed: hasClaimed });
    } catch (err) {
        res.status(500).json({ error: "Status check failed" });
    }
});

// 4. Automated Counter Scan Endpoint
app.post('/api/scan', async (req, res) => {
    try {
        const { scholarId } = req.body;
        const cleanId = scholarId.trim();
        
        const slot = getCurrentMealSlot();
        if (!slot.active) return res.json({ status: 'error', message: "No active meal service at this time." });

        // Atomic Operation: Find student where lastClaimedMeal is NOT the current slot, and update it.
        const claimedStudent = await Student.findOneAndUpdate(
            { scholarId: cleanId, lastClaimedMeal: { $ne: slot.id } },
            { $set: { lastClaimedMeal: slot.id } },
            { new: true }
        ).lean();

        if (claimedStudent) {
            return res.json({ status: 'allowed', name: claimedStudent.name, room: claimedStudent.room });
        }

        // If the atomic update fails, either the student doesn't exist, or they already claimed.
        const existingStudent = await Student.findOne({ scholarId: cleanId }).lean();
        if (!existingStudent) return res.json({ status: 'error', message: "Unrecognized ID Card" });

        return res.json({ status: 'denied', name: existingStudent.name, room: existingStudent.room });
    } catch (err) {
        res.status(500).json({ status: 'error', message: "Database lookup failed." });
    }
});

const PORT = 3000;
app.listen(PORT, () => console.log(`🚀 Production server listening on port ${PORT}`));