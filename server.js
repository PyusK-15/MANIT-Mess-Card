const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');

// ---------------------------------------------------------------------------
// Config (everything secret comes from environment variables, never from code)
// ---------------------------------------------------------------------------
const {
    MONGO_URI,
    JWT_SECRET,
    STAFF_PASSWORD,
    BREVO_API_KEY,
    MAIL_FROM,
    MAIL_FROM_NAME = 'MANIT Mess Card'
} = process.env;
const IS_PROD = process.env.NODE_ENV === 'production';

for (const [k, v] of Object.entries({ MONGO_URI, JWT_SECRET, STAFF_PASSWORD })) {
    if (!v) {
        console.error(`Missing required environment variable: ${k}`);
        process.exit(1);
    }
}
if (IS_PROD && (!BREVO_API_KEY || !MAIL_FROM)) {
    console.error('BREVO_API_KEY and MAIL_FROM are required in production (OTP emails cannot be sent without them).');
    process.exit(1);
}

const OTP_TTL_MS = 10 * 60 * 1000;   // OTP valid for 10 minutes
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const QR_TTL_SECONDS = 60;           // QR token lifetime (frontend refreshes before this)
const EMAIL_DOMAIN = 'stu.manit.ac.in';

const app = express();
app.set('trust proxy', 1); // Render sits behind a proxy; needed for correct client IPs
app.use(express.json({ limit: '1mb' })); // photo is a ~30 KB compressed JPEG, 15 MB was far too much
app.use(express.static(path.join(__dirname, 'public')));

mongoose.connect(MONGO_URI, {
    maxPoolSize: 50,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000
}).then(() => console.log('MongoDB Atlas connected'))
  .catch(err => console.error('MongoDB connection error:', err.message));

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------
const studentSchema = new mongoose.Schema({
    scholarId: { type: String, required: true, unique: true },
    collegeEmail: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    room: { type: String, required: true },
    passwordHash: { type: String },
    password: { type: String },            // LEGACY plaintext field; removed automatically on next successful login
    photo: { type: String, required: true },
    lastClaimedMeal: { type: String, default: '' }
}, { timestamps: true });
const Student = mongoose.model('Student', studentSchema);

const otpSchema = new mongoose.Schema({
    scholarId: { type: String, required: true, unique: true },
    otpHash: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    lastSentAt: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now, expires: 600 } // TTL cleanup
});
const OtpRecord = mongoose.model('OtpRecord', otpSchema);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
// Only plain strings that look like a scholar number are accepted. This also stops
// anyone from injecting other addresses into the email we build from it, and blocks
// NoSQL-injection objects like {"$ne": null}.
// Tighten this to the real format if you know it (e.g. /^\d{9}$/).
function normalizeId(v) {
    if (typeof v !== 'string') return null;
    const id = v.trim().toLowerCase();
    return /^[a-z0-9]{6,15}$/.test(id) ? id : null;
}

function hashOtp(scholarId, otp) {
    // HMAC (not a bare hash): a 6-digit code has only 1M possibilities, so a plain hash is trivially reversible.
    return crypto.createHmac('sha256', JWT_SECRET).update(`otp:${scholarId}:${otp}`).digest('hex');
}

function safeEqual(a, b) {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
}

function signQrToken(scholarId) {
    const exp = Math.floor(Date.now() / 1000) + QR_TTL_SECONDS;
    const sig = crypto.createHmac('sha256', JWT_SECRET).update(`qr:${scholarId}.${exp}`).digest('hex').slice(0, 20);
    return `${scholarId}.${exp}.${sig}`; // short on purpose so the QR stays easy to scan
}

function verifyQrToken(token) {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [scholarId, expStr, sig] = parts;
    const exp = Number(expStr);
    if (!normalizeId(scholarId) || !Number.isInteger(exp)) return null;
    if (exp < Math.floor(Date.now() / 1000)) return null;
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(`qr:${scholarId}.${exp}`).digest('hex').slice(0, 20);
    return safeEqual(sig, expected) ? scholarId : null;
}

async function checkPassword(student, plain) {
    if (student.passwordHash) return bcrypt.compare(plain, student.passwordHash);
    // Legacy account with a plaintext password: verify, then upgrade to a hash.
    if (student.password && safeEqual(student.password, plain)) {
        student.passwordHash = await bcrypt.hash(plain, 10);
        student.password = undefined;
        await student.save();
        return true;
    }
    return false;
}

function bearer(req) {
    const h = req.headers.authorization || '';
    return h.startsWith('Bearer ') ? h.slice(7) : '';
}

function requireKind(kind) {
    return (req, res, next) => {
        try {
            const payload = jwt.verify(bearer(req), JWT_SECRET);
            if (payload.kind !== kind) throw new Error('wrong token kind');
            req.auth = payload;
            next();
        } catch {
            res.status(401).json({ success: false, message: 'Session expired. Please log in again.' });
        }
    };
}
const requireStudent = requireKind('session');
const requireStaff = requireKind('staff');

async function sendOtpEmail(to, otp) {
    if (!BREVO_API_KEY) {
        // Local development only (production refuses to start without a key). The OTP is NEVER sent to the browser.
        console.log(`[DEV ONLY] OTP for ${to}: ${otp}`);
        return;
    }
    // HTTPS API call, not SMTP: Render's free tier blocks outbound SMTP ports.
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', 'api-key': BREVO_API_KEY },
        body: JSON.stringify({
            sender: { name: MAIL_FROM_NAME, email: MAIL_FROM },
            to: [{ email: to }],
            subject: 'Your MANIT Mess Card verification code',
            textContent: `Your verification code is ${otp}. It is valid for 10 minutes. Do not share it with anyone.`,
            htmlContent: `<p>Your MANIT Mess Card verification code is:</p>
                          <p style="font-size:28px;font-weight:bold;letter-spacing:6px">${otp}</p>
                          <p>Valid for 10 minutes. Do not share it with anyone.<br>If you did not request this, ignore this email.</p>`
        }),
        signal: AbortSignal.timeout(10000)
    });
    if (!r.ok) throw new Error(`Email provider error ${r.status}: ${await r.text()}`);
}

function getCurrentMealSlot() {
    const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const hh = d.getHours().toString().padStart(2, '0');
    const mm = d.getMinutes().toString().padStart(2, '0');
    const timeStr = `${hh}:${mm}`;
    const dateStr = `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`;

    let mealSlot;
    if (timeStr >= '07:30' && timeStr < '11:00') mealSlot = 'Breakfast';
    else if (timeStr >= '12:30' && timeStr < '15:30') mealSlot = 'Lunch';
    else if (timeStr >= '17:00' && timeStr < '18:30') mealSlot = 'Snacks';
    else if (timeStr >= '19:30' && timeStr < '22:30') mealSlot = 'Dinner';
    else mealSlot = 'Special / Off-Peak Service';

    return { active: true, id: `${dateStr}-${mealSlot}`, name: mealSlot };
}

// ---------------------------------------------------------------------------
// Rate limits
// Many students share the campus/hostel Wi-Fi IP, so per-IP limits are generous;
// the real protection is the per-scholar cooldown and attempt cap stored in the DB.
// ---------------------------------------------------------------------------
const limitMsg = { success: false, message: 'Too many requests. Please wait a few minutes and try again.' };
const otpIpLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 100, standardHeaders: true, legacyHeaders: false, message: limitMsg });
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, message: limitMsg,
    keyGenerator: (req) => normalizeId(req.body && req.body.scholarId) || 'anon' // per account: 10 tries / 15 min
});
const staffLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, message: limitMsg });

// ---------------------------------------------------------------------------
// 1. Request OTP: generates a code and EMAILS it. The code is never returned to the browser.
// ---------------------------------------------------------------------------
app.post('/api/request-otp', otpIpLimiter, async (req, res) => {
    try {
        const scholarId = normalizeId(req.body.scholarId);
        if (!scholarId) return res.status(400).json({ success: false, message: 'Enter a valid Scholar Number.' });

        if (await Student.exists({ scholarId })) {
            return res.status(409).json({ success: false, message: 'Account already exists for this Scholar Number. Please log in.' });
        }

        const existing = await OtpRecord.findOne({ scholarId }).lean();
        if (existing && Date.now() - new Date(existing.lastSentAt).getTime() < OTP_RESEND_COOLDOWN_MS) {
            const wait = Math.ceil((OTP_RESEND_COOLDOWN_MS - (Date.now() - new Date(existing.lastSentAt).getTime())) / 1000);
            return res.status(429).json({ success: false, message: `Please wait ${wait}s before requesting another OTP.` });
        }

        const otp = crypto.randomInt(0, 1000000).toString().padStart(6, '0');
        const now = new Date();
        await OtpRecord.findOneAndUpdate(
            { scholarId },
            { $set: { otpHash: hashOtp(scholarId, otp), attempts: 0, lastSentAt: now, createdAt: now } },
            { upsert: true }
        );

        const email = `${scholarId}@${EMAIL_DOMAIN}`;
        try {
            await sendOtpEmail(email, otp);
        } catch (mailErr) {
            console.error('OTP email failed:', mailErr.message);
            await OtpRecord.deleteOne({ scholarId });
            return res.status(502).json({ success: false, message: 'Could not send the email right now. Please try again shortly.' });
        }

        res.json({ success: true, email, message: `OTP sent to ${email}` });
    } catch (err) {
        console.error('request-otp error:', err);
        res.status(500).json({ success: false, message: 'Failed to issue verification OTP.' });
    }
});

// ---------------------------------------------------------------------------
// 2. Verify OTP and create the account
// ---------------------------------------------------------------------------
app.post('/api/verify-and-register', otpIpLimiter, async (req, res) => {
    try {
        const scholarId = normalizeId(req.body.scholarId);
        const { otp, name, room, password, photo } = req.body;

        // Validate EVERYTHING first so a typo in the form doesn't burn the OTP.
        if (!scholarId) return res.status(400).json({ success: false, message: 'Invalid Scholar Number.' });
        if (typeof otp !== 'string' || !/^\d{6}$/.test(otp.trim())) return res.status(400).json({ success: false, message: 'Enter the 6-digit OTP.' });
        if (typeof name !== 'string' || !name.trim() || name.trim().length > 60) return res.status(400).json({ success: false, message: 'Enter a valid name (max 60 characters).' });
        if (typeof room !== 'string' || !room.trim() || room.trim().length > 40) return res.status(400).json({ success: false, message: 'Enter a valid hostel/room (max 40 characters).' });
        if (typeof password !== 'string' || password.length < 6 || password.length > 72) return res.status(400).json({ success: false, message: 'Password must be 6 to 72 characters.' });
        if (typeof photo !== 'string' || photo.length > 300000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(photo)) {
            return res.status(400).json({ success: false, message: 'Invalid photo. Please upload it again.' });
        }

        // Atomically count this attempt (blocks parallel guessing) and make sure the OTP is fresh and not exhausted.
        const rec = await OtpRecord.findOneAndUpdate(
            { scholarId, attempts: { $lt: OTP_MAX_ATTEMPTS }, createdAt: { $gt: new Date(Date.now() - OTP_TTL_MS) } },
            { $inc: { attempts: 1 } },
            { new: true }
        );
        if (!rec) {
            await OtpRecord.deleteOne({ scholarId });
            return res.status(400).json({ success: false, message: 'OTP expired or too many wrong attempts. Please request a new OTP.' });
        }

        if (!safeEqual(rec.otpHash, hashOtp(scholarId, otp.trim()))) {
            const left = OTP_MAX_ATTEMPTS - rec.attempts;
            return res.status(400).json({ success: false, message: left > 0 ? `Wrong OTP. ${left} attempt(s) left.` : 'Wrong OTP. Please request a new one.' });
        }

        // Consume the OTP exactly once (safe even if two requests arrive together).
        const consumed = await OtpRecord.findOneAndDelete({ scholarId, otpHash: rec.otpHash });
        if (!consumed) return res.status(400).json({ success: false, message: 'OTP already used. Please request a new one.' });

        try {
            await Student.create({
                scholarId,
                collegeEmail: `${scholarId}@${EMAIL_DOMAIN}`,
                name: name.trim(),
                room: room.trim(),
                passwordHash: await bcrypt.hash(password, 10),
                photo
            });
        } catch (e) {
            if (e.code === 11000) return res.status(409).json({ success: false, message: 'Account already exists. Please log in.' });
            throw e;
        }

        res.status(201).json({ success: true, message: 'Registration successful! You can now log in.' });
    } catch (err) {
        console.error('verify-and-register error:', err);
        res.status(500).json({ success: false, message: 'Registration failed.' });
    }
});

// ---------------------------------------------------------------------------
// 3. Student login: returns a session token
// ---------------------------------------------------------------------------
app.post('/api/login', loginLimiter, async (req, res) => {
    try {
        const scholarId = normalizeId(req.body.scholarId);
        const password = req.body.password;
        // typeof check blocks {"password": {"$ne": null}} style NoSQL injection
        if (!scholarId || typeof password !== 'string' || !password) {
            return res.status(401).json({ success: false, message: 'Invalid Scholar ID or password.' });
        }
        const student = await Student.findOne({ scholarId });
        if (!student || !(await checkPassword(student, password))) {
            return res.status(401).json({ success: false, message: 'Invalid Scholar ID or password.' });
        }
        const token = jwt.sign({ sub: student.scholarId, kind: 'session' }, JWT_SECRET, { expiresIn: '30d' });
        res.json({
            success: true,
            token,
            student: { scholarId: student.scholarId, name: student.name, room: student.room, photo: student.photo }
        });
    } catch (err) {
        console.error('login error:', err);
        res.status(500).json({ success: false, message: 'Login error.' });
    }
});

// ---------------------------------------------------------------------------
// 4. Student endpoints (need a session token)
// ---------------------------------------------------------------------------
app.get('/api/qr-token', requireStudent, (req, res) => {
    res.json({ success: true, token: signQrToken(req.auth.sub), expiresIn: QR_TTL_SECONDS });
});

app.get('/api/status', requireStudent, async (req, res) => {
    try {
        const slot = getCurrentMealSlot();
        const student = await Student.findOne({ scholarId: req.auth.sub }).select('lastClaimedMeal').lean();
        res.json({ activeSlot: slot.name, claimed: !!student && student.lastClaimedMeal === slot.id });
    } catch (err) {
        res.status(500).json({ error: 'Check failed' });
    }
});

// ---------------------------------------------------------------------------
// 5. Staff: login, scan, resets (all need a staff token)
// ---------------------------------------------------------------------------
app.post('/api/staff-login', staffLimiter, (req, res) => {
    const { password } = req.body;
    if (typeof password !== 'string' || !safeEqual(password, STAFF_PASSWORD)) {
        return res.status(401).json({ success: false, message: 'Invalid staff password.' });
    }
    const token = jwt.sign({ kind: 'staff' }, JWT_SECRET, { expiresIn: '12h' });
    res.json({ success: true, token });
});

app.post('/api/scan', requireStaff, async (req, res) => {
    try {
        const scholarId = verifyQrToken(req.body.token);
        if (!scholarId) {
            return res.json({ status: 'error', message: 'Invalid or expired QR. Ask the student to refresh their card.' });
        }
        const slot = getCurrentMealSlot();

        // Atomic: only one scan per student per meal slot can ever succeed.
        const claimed = await Student.findOneAndUpdate(
            { scholarId, lastClaimedMeal: { $ne: slot.id } },
            { $set: { lastClaimedMeal: slot.id } },
            { new: true }
        ).lean();

        if (claimed) {
            return res.json({ status: 'allowed', name: claimed.name, room: claimed.room, photo: claimed.photo, scholarId, slot: slot.name });
        }
        const existing = await Student.findOne({ scholarId }).lean();
        if (!existing) return res.json({ status: 'error', message: 'Unregistered Scholar ID' });
        return res.json({ status: 'denied', name: existing.name, room: existing.room, photo: existing.photo, scholarId, slot: slot.name });
    } catch (err) {
        console.error('scan error:', err);
        res.status(500).json({ status: 'error', message: 'Scan processing error.' });
    }
});

app.post('/api/reset-one', requireStaff, async (req, res) => {
    try {
        const scholarId = normalizeId(req.body.scholarId);
        if (!scholarId) return res.status(400).json({ success: false, message: 'Invalid Scholar ID' });
        const updated = await Student.findOneAndUpdate({ scholarId }, { $set: { lastClaimedMeal: '' } });
        if (!updated) return res.status(404).json({ success: false, message: 'Scholar ID not found' });
        res.json({ success: true, message: `Reset successful for Scholar ID: ${scholarId}` });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Reset failed' });
    }
});

// Note: claims are keyed per meal slot (date + meal), so every new meal starts fresh automatically.
// "Reset all" only matters if you want to let everyone eat again within the SAME meal window.
app.post('/api/reset-all', requireStaff, async (req, res) => {
    try {
        await Student.updateMany({}, { $set: { lastClaimedMeal: '' } });
        res.json({ success: true, message: 'All student cards reset successfully!' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Reset all failed' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
