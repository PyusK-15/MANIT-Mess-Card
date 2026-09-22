const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const nodemailer = require('nodemailer');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const app = express();

/* =========================================================
   BASIC SERVER CONFIGURATION
========================================================= */

app.use(express.json({ limit: '15mb' }));
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

/* =========================================================
   ENVIRONMENT VARIABLES
========================================================= */

const MONGO_URI = process.env.MONGO_URI;

const EMAIL_1 = process.env.EMAIL_1;
const PASS_1 = process.env.PASS_1;

const EMAIL_2 = process.env.EMAIL_2;
const PASS_2 = process.env.PASS_2;

/*
   Temporary/demo staff PIN.
   We will secure staff authentication separately later.
*/
const STAFF_PIN = process.env.STAFF_PIN || 'manitH10';

/* =========================================================
   MONGODB
========================================================= */

if (!MONGO_URI) {
    console.error("❌ MONGO_URI is missing from environment variables.");
    process.exit(1);
}

mongoose.connect(MONGO_URI, {
    maxPoolSize: 50,
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 45000
})
.then(() => {
    console.log("✅ MongoDB Atlas Connected Successfully");
})
.catch(err => {
    console.error("❌ MongoDB Connection Error:", err.message);
});

/* =========================================================
   STUDENT MODEL
========================================================= */

const studentSchema = new mongoose.Schema({
    scholarId: {
        type: String,
        required: true,
        unique: true,
        index: true
    },

    collegeEmail: {
        type: String,
        required: true,
        unique: true
    },

    name: {
        type: String,
        required: true
    },

    room: {
        type: String,
        required: true
    },

    /*
      New accounts use passwordHash.
      password is retained only so older test accounts
      created by the previous version don't immediately break.
    */
    passwordHash: {
        type: String
    },

    password: {
        type: String
    },

    photo: {
        type: String,
        required: true
    },

    /*
      emailVerified = OTP verification.
      isVerified = physical verification/activation by mess staff.
    */
    emailVerified: {
        type: Boolean,
        default: false
    },

    isVerified: {
        type: Boolean,
        default: false
    },

    lastClaimedMeal: {
        type: String,
        default: ''
    }

}, { timestamps: true });

const Student = mongoose.model('Student', studentSchema);

/* =========================================================
   PENDING REGISTRATION MODEL
========================================================= */

const pendingRegistrationSchema = new mongoose.Schema({

    scholarId: {
        type: String,
        required: true,
        unique: true,
        index: true
    },

    collegeEmail: {
        type: String,
        required: true
    },

    name: {
        type: String,
        required: true
    },

    room: {
        type: String,
        required: true
    },

    passwordHash: {
        type: String,
        required: true
    },

    photo: {
        type: String,
        required: true
    },

    otpHash: {
        type: String,
        required: true
    },

    otpExpiresAt: {
        type: Date,
        required: true
    },

    /*
      MongoDB automatically deletes this document
      after 10 minutes.
    */
    expiresAt: {
        type: Date,
        required: true,
        index: { expires: 0 }
    },

    attempts: {
        type: Number,
        default: 0
    },

    lastSentAt: {
        type: Date,
        default: null
    },

    sendWindowStartedAt: {
        type: Date,
        default: null
    },

    sendCount: {
        type: Number,
        default: 0
    }

}, { timestamps: true });

const PendingRegistration =
    mongoose.model('PendingRegistration', pendingRegistrationSchema);

/* =========================================================
   EMAIL CONFIGURATION
========================================================= */

let transporter1 = null;
let transporter2 = null;

if (EMAIL_1 && PASS_1) {

    transporter1 = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: EMAIL_1,
            pass: PASS_1
        }
    });

    console.log(`📧 Email account 1 configured: ${EMAIL_1}`);

} else {

    console.log("⚠️ EMAIL_1 / PASS_1 not configured.");

}


if (EMAIL_2 && PASS_2) {

    transporter2 = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: EMAIL_2,
            pass: PASS_2
        }
    });

    console.log(`📧 Email account 2 configured: ${EMAIL_2}`);

} else {

    console.log("⚠️ EMAIL_2 / PASS_2 not configured.");

}

/* =========================================================
   HELPER: SEND OTP EMAIL
========================================================= */

async function sendOTPEmail(toEmail, otp) {

    if (!transporter1 && !transporter2) {
        throw new Error(
            "Email service is not configured. Add EMAIL_1/PASS_1 or EMAIL_2/PASS_2."
        );
    }

    const mailOptions = {
        to: toEmail,
        subject: "MANIT Digital Mess Card - OTP Verification",

        text:
`MANIT Digital Mess Card

Your OTP is: ${otp}

This OTP is valid for 10 minutes.

If you did not request registration, please ignore this email.

MANIT Digital Mess Card System`,

        html: `
            <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:25px;border:1px solid #ddd;border-radius:10px;">

                <h2>MANIT Digital Mess Card</h2>

                <p>Your registration verification OTP is:</p>

                <div style="
                    font-size:32px;
                    font-weight:bold;
                    letter-spacing:8px;
                    padding:15px;
                    background:#f3f3f3;
                    text-align:center;
                    border-radius:8px;
                    margin:20px 0;
                ">
                    ${otp}
                </div>

                <p>
                    This OTP is valid for <strong>10 minutes</strong>.
                </p>

                <p>
                    If you did not request this registration,
                    you can safely ignore this email.
                </p>

                <hr>

                <p style="font-size:12px;color:#777;">
                    MANIT Digital Mess Card System
                </p>

            </div>
        `
    };

    /*
      Try Gmail account 1 first.
    */

    if (transporter1) {

        try {

            await transporter1.sendMail({
                ...mailOptions,
                from: EMAIL_1
            });

            console.log(`📨 OTP sent using EMAIL_1 to ${toEmail}`);

            return {
                success: true,
                sender: EMAIL_1
            };

        } catch (error) {

            console.error(
                "⚠️ EMAIL_1 failed:",
                error.message
            );

        }
    }

    /*
      If account 1 fails, try account 2.
    */

    if (transporter2) {

        try {

            await transporter2.sendMail({
                ...mailOptions,
                from: EMAIL_2
            });

            console.log(`📨 OTP sent using EMAIL_2 to ${toEmail}`);

            return {
                success: true,
                sender: EMAIL_2
            };

        } catch (error) {

            console.error(
                "❌ EMAIL_2 failed:",
                error.message
            );

        }
    }

    throw new Error("Both email accounts failed to send the OTP.");

}

/* =========================================================
   HELPER: CURRENT MEAL
========================================================= */

function getCurrentMealSlot() {

    const d = new Date(
        new Date().toLocaleString(
            "en-US",
            { timeZone: "Asia/Kolkata" }
        )
    );

    const hh = d.getHours().toString().padStart(2, '0');
    const mm = d.getMinutes().toString().padStart(2, '0');

    const timeStr = `${hh}:${mm}`;

    const dateStr =
        `${d.getFullYear()}-` +
        `${(d.getMonth() + 1).toString().padStart(2, '0')}-` +
        `${d.getDate().toString().padStart(2, '0')}`;

    let mealSlot = "Mess Service";

    if (timeStr >= "07:30" && timeStr < "11:00") {

        mealSlot = "Breakfast";

    } else if (timeStr >= "12:30" && timeStr < "15:30") {

        mealSlot = "Lunch";

    } else if (timeStr >= "17:00" && timeStr < "18:30") {

        mealSlot = "Snacks";

    } else if (timeStr >= "19:30" && timeStr < "22:30") {

        mealSlot = "Dinner";

    } else {

        mealSlot = "Special / Off-Peak Service";

    }

    return {
        active: true,
        id: `${dateStr}-${mealSlot}`,
        name: mealSlot
    };
}

/* =========================================================
   HELPER: SCHOLAR ID
========================================================= */

function cleanScholarId(value) {

    return String(value || '')
        .trim()
        .toLowerCase();

}

/* =========================================================
   HELPER: MASK EMAIL
========================================================= */

function maskEmail(email) {

    const parts = email.split('@');

    if (parts.length !== 2) {
        return email;
    }

    const username = parts[0];

    if (username.length <= 2) {
        return `**@${parts[1]}`;
    }

    return (
        username.substring(0, 2) +
        '*'.repeat(Math.max(2, username.length - 2)) +
        '@' +
        parts[1]
    );

}

/* =========================================================
   1. SEND OTP
========================================================= */

app.post('/api/send-otp', async (req, res) => {

    try {

        const {
            scholarId,
            name,
            room,
            password,
            photo
        } = req.body;

        if (!scholarId || !name || !room || !password || !photo) {

            return res.status(400).json({
                success: false,
                message: "All registration fields are required."
            });

        }

      const cleanId = cleanScholarId(scholarId);

if (!cleanId) {
  return res.status(400).json({
    success: false,
    message: "Please enter your scholar number."
  });
}

const collegeEmail = `${cleanId}@stu.manit.ac.in`;

        /*
          Check if account already exists.
        */

        const existingStudent =
            await Student.findOne({
                $or: [
                    { scholarId: cleanId },
                    { collegeEmail: collegeEmail }
                ]
            });

        if (existingStudent) {

            return res.status(409).json({
                success: false,
                message:
                    "An account already exists for this Scholar ID. Please log in."
            });

        }

        /*
          Find previous pending registration.
        */

        let pending =
            await PendingRegistration.findOne({
                scholarId: cleanId
            });

        const now = new Date();

        /*
          Prevent OTP spam:
          Minimum 60 seconds between OTP requests.
        */

        if (
            pending &&
            pending.lastSentAt &&
            (now.getTime() - pending.lastSentAt.getTime()) < 60000
        ) {

            const secondsLeft = Math.ceil(
                60 -
                ((now.getTime() - pending.lastSentAt.getTime()) / 1000)
            );

            return res.status(429).json({
                success: false,
                message:
                    `Please wait ${secondsLeft} seconds before requesting another OTP.`
            });

        }

        /*
          Limit to 5 OTP sends per hour.
        */

        if (pending) {

            if (
                pending.sendWindowStartedAt &&
                (now.getTime() -
                    pending.sendWindowStartedAt.getTime()) >=
                60 * 60 * 1000
            ) {

                pending.sendWindowStartedAt = now;
                pending.sendCount = 0;

            }

            if (pending.sendCount >= 5) {

                return res.status(429).json({
                    success: false,
                    message:
                        "Too many OTP requests. Please try again later."
                });

            }

        }

        /*
          Generate secure 6-digit OTP.
        */

        const otp =
            crypto.randomInt(100000, 1000000).toString();

        const otpHash =
            crypto
                .createHash('sha256')
                .update(otp)
                .digest('hex');

        const passwordHash =
            await bcrypt.hash(password, 12);

        const expiresAt =
            new Date(Date.now() + 10 * 60 * 1000);

        if (!pending) {

            pending = new PendingRegistration({
                scholarId: cleanId,
                collegeEmail,
                name: name.trim(),
                room: room.trim(),
                passwordHash,
                photo,
                otpHash,
                otpExpiresAt: expiresAt,
                expiresAt,
                attempts: 0,
                lastSentAt: now,
                sendWindowStartedAt: now,
                sendCount: 1
            });

        } else {

            pending.collegeEmail = collegeEmail;
            pending.name = name.trim();
            pending.room = room.trim();
            pending.passwordHash = passwordHash;
            pending.photo = photo;
            pending.otpHash = otpHash;
            pending.otpExpiresAt = expiresAt;
            pending.expiresAt = expiresAt;
            pending.attempts = 0;
            pending.lastSentAt = now;
            pending.sendCount += 1;

            if (!pending.sendWindowStartedAt) {
                pending.sendWindowStartedAt = now;
            }

        }

        await pending.save();

        /*
          Send email.
        */

        try {

            const result =
                await sendOTPEmail(
                    collegeEmail,
                    otp
                );

            console.log(
                `✅ OTP successfully sent to ${collegeEmail} using ${result.sender}`
            );

            return res.json({

                success: true,

                message:
                    `OTP sent to ${maskEmail(collegeEmail)}.`,

                email:
                    maskEmail(collegeEmail),

                expiresIn: 600

            });

        } catch (emailError) {

            console.error(
                "❌ OTP Email Error:",
                emailError
            );

            /*
              Delete failed pending registration
              so the user can try again.
            */

            await PendingRegistration.deleteOne({
                scholarId: cleanId
            });

            return res.status(500).json({

                success: false,

                message:
                    "Could not send OTP. Please check the email service configuration."

            });

        }

    } catch (err) {

        console.error(
            "❌ Send OTP Error:",
            err
        );

        return res.status(500).json({

            success: false,

            message:
                "Failed to send OTP."

        });

    }

});

/* =========================================================
   2. VERIFY OTP AND CREATE ACCOUNT
========================================================= */

app.post('/api/verify-otp', async (req, res) => {

    try {

        const {
            scholarId,
            otp
        } = req.body;

        if (!scholarId || !otp) {

            return res.status(400).json({
                success: false,
                message: "Scholar ID and OTP are required."
            });

        }

        const cleanId =
            cleanScholarId(scholarId);

        const pending =
            await PendingRegistration.findOne({
                scholarId: cleanId
            });

        if (!pending) {

            return res.status(404).json({
                success: false,
                message:
                    "Registration request not found or OTP expired. Please request a new OTP."
            });

        }

        /*
          Check OTP expiry.
        */

        if (
            new Date() >
            pending.otpExpiresAt
        ) {

            await PendingRegistration.deleteOne({
                scholarId: cleanId
            });

            return res.status(400).json({
                success: false,
                message:
                    "OTP has expired. Please request a new OTP."
            });

        }

        /*
          Maximum 5 wrong attempts.
        */

        if (pending.attempts >= 5) {

            await PendingRegistration.deleteOne({
                scholarId: cleanId
            });

            return res.status(429).json({
                success: false,
                message:
                    "Too many incorrect OTP attempts. Please request a new OTP."
            });

        }

        const submittedHash =
            crypto
                .createHash('sha256')
                .update(String(otp).trim())
                .digest('hex');

        if (
            submittedHash !==
            pending.otpHash
        ) {

            pending.attempts += 1;

            await pending.save();

            return res.status(400).json({
                success: false,
                message:
                    "Incorrect OTP."
            });

        }

        /*
          Check once more that the account wasn't created
          while the OTP was pending.
        */

        const existingStudent =
            await Student.findOne({
                $or: [
                    { scholarId: cleanId },
                    { collegeEmail: pending.collegeEmail }
                ]
            });

        if (existingStudent) {

            await PendingRegistration.deleteOne({
                scholarId: cleanId
            });

            return res.status(409).json({
                success: false,
                message:
                    "An account already exists for this Scholar ID."
            });

        }

        /*
          Create verified email account.
        */

        const newStudent =
            new Student({

                scholarId: pending.scholarId,

                collegeEmail:
                    pending.collegeEmail,

                name:
                    pending.name,

                room:
                    pending.room,

                passwordHash:
                    pending.passwordHash,

                photo:
                    pending.photo,

                emailVerified:
                    true,

                /*
                  Physical MANIT/mess activation still happens
                  when staff scans the card.
                */
                isVerified:
                    false,

                lastClaimedMeal:
                    ''

            });

        await newStudent.save();

        /*
          Delete pending registration.
        */

        await PendingRegistration.deleteOne({
            scholarId: cleanId
        });

        return res.status(201).json({

            success: true,

            message:
                "Email verified! Account created successfully. Present your physical MANIT ID at the mess for first-time activation.",

            student: {

                scholarId:
                    newStudent.scholarId,

                name:
                    newStudent.name,

                room:
                    newStudent.room,

                photo:
                    newStudent.photo,

                isVerified:
                    newStudent.isVerified,

                emailVerified:
                    true

            }

        });

    } catch (err) {

        console.error(
            "❌ Verify OTP Error:",
            err
        );

        return res.status(500).json({

            success: false,

            message:
                "OTP verification failed."

        });

    }

});

/* =========================================================
   3. STUDENT LOGIN
========================================================= */

app.post('/api/login', async (req, res) => {

    try {

        const {
            scholarId,
            password
        } = req.body;

        const cleanId =
            cleanScholarId(scholarId);

        const student =
            await Student.findOne({
                scholarId: cleanId
            });

        if (!student) {

            return res.status(401).json({
                success: false,
                message:
                    "Invalid Scholar ID or password."
            });

        }

        let passwordCorrect = false;

        /*
          New accounts: bcrypt password.
        */

        if (student.passwordHash) {

            passwordCorrect =
                await bcrypt.compare(
                    password,
                    student.passwordHash
                );

        }

        /*
          Old test accounts:
          temporarily support their old plaintext password,
          then automatically convert it to bcrypt.
        */

        else if (
            student.password &&
            student.password === password
        ) {

            passwordCorrect = true;

            const newHash =
                await bcrypt.hash(
                    password,
                    12
                );

            await Student.updateOne(
                { _id: student._id },
                {
                    $set: {
                        passwordHash: newHash
                    },
                    $unset: {
                        password: ""
                    }
                }
            );

        }

        if (!passwordCorrect) {

            return res.status(401).json({
                success: false,
                message:
                    "Invalid Scholar ID or password."
            });

        }

        return res.json({

            success: true,

            student: {

                scholarId:
                    student.scholarId,

                name:
                    student.name,

                room:
                    student.room,

                photo:
                    student.photo,

                isVerified:
                    student.isVerified,

                emailVerified:
                    student.emailVerified !== false

            }

        });

    } catch (err) {

        console.error(
            "❌ Login Error:",
            err
        );

        return res.status(500).json({

            success: false,

            message:
                "Login error."

        });

    }

});

/* =========================================================
   4. STUDENT STATUS
========================================================= */

app.get('/api/status/:scholarId', async (req, res) => {

    try {

        const slot =
            getCurrentMealSlot();

        const student =
            await Student.findOne({
                scholarId:
                    cleanScholarId(
                        req.params.scholarId
                    )
            }).lean();

        if (!student) {

            return res.json({

                activeSlot:
                    slot.name,

                claimed:
                    false,

                isVerified:
                    false

            });

        }

        const hasClaimed =
            student.lastClaimedMeal === slot.id;

        return res.json({

            activeSlot:
                slot.name,

            claimed:
                hasClaimed,

            isVerified:
                student.isVerified,

            emailVerified:
                student.emailVerified !== false

        });

    } catch (err) {

        console.error(
            "❌ Status Error:",
            err
        );

        return res.status(500).json({
            error:
                "Check failed"
        });

    }

});

/* =========================================================
   5. STAFF SCANNER
========================================================= */

app.post('/api/scan', async (req, res) => {

    try {

        const cleanId =
            cleanScholarId(
                req.body.scholarId
            );

        if (!cleanId) {

            return res.json({
                status: 'error',
                message:
                    "Invalid Scholar ID"
            });

        }

        const slot =
            getCurrentMealSlot();

        const student =
            await Student.findOne({
                scholarId: cleanId
            });

        if (!student) {

            return res.json({

                status:
                    'error',

                message:
                    "Unregistered Student"

            });

        }

        /*
          Email must be verified before mess access.
        */

        if (
            student.emailVerified === false
        ) {

            return res.json({

                status:
                    'denied',

                name:
                    student.name,

                room:
                    student.room,

                message:
                    "Student email has not been verified."

            });

        }

        /*
          First physical scan activates the card.
        */

        let justActivated = false;

        if (!student.isVerified) {

            student.isVerified = true;

            justActivated = true;

        }

        /*
          Prevent duplicate meal claim.
        */

        if (
            student.lastClaimedMeal ===
            slot.id
        ) {

            return res.json({

                status:
                    'denied',

                name:
                    student.name,

                room:
                    student.room,

                message:
                    "Meal already claimed for this meal slot."

            });

        }

        student.lastClaimedMeal =
            slot.id;

        await student.save();

        return res.json({

            status:
                'allowed',

            name:
                student.name,

            room:
                student.room,

            activated:
                justActivated

        });

    } catch (err) {

        console.error(
            "❌ Scan Error:",
            err
        );

        return res.status(500).json({

            status:
                'error',

            message:
                "Scan processing error."

        });

    }

});

/* =========================================================
   6. STAFF RESET ONE
========================================================= */

app.post('/api/reset-one', async (req, res) => {

    try {

        const {
            scholarId,
            staffPin
        } = req.body;

        if (
            staffPin !== STAFF_PIN
        ) {

            return res.status(403).json({

                success:
                    false,

                message:
                    "Unauthorized PIN"

            });

        }

        const updated =
            await Student.findOneAndUpdate(

                {
                    scholarId:
                        cleanScholarId(
                            scholarId
                        )
                },

                {
                    $set: {
                        lastClaimedMeal:
                            ''
                    }
                }

            );

        if (!updated) {

            return res.status(404).json({

                success:
                    false,

                message:
                    "Scholar ID not found"

            });

        }

        return res.json({

            success:
                true,

            message:
                `Reset complete for ${scholarId}`

        });

    } catch (err) {

        console.error(
            "❌ Reset One Error:",
            err
        );

        return res.status(500).json({

            success:
                false,

            message:
                "Reset failed"

        });

    }

});

/* =========================================================
   7. STAFF RESET ALL
========================================================= */

app.post('/api/reset-all', async (req, res) => {

    try {

        const {
            staffPin
        } = req.body;

        if (
            staffPin !== STAFF_PIN
        ) {

            return res.status(403).json({

                success:
                    false,

                message:
                    "Unauthorized PIN"

            });

        }

        await Student.updateMany(
            {},
            {
                $set: {
                    lastClaimedMeal:
                        ''
                }
            }
        );

        return res.json({

            success:
                true,

            message:
                "All student cards reset successfully!"

        });

    } catch (err) {

        console.error(
            "❌ Reset All Error:",
            err
        );

        return res.status(500).json({

            success:
                false,

            message:
                "Reset all failed"

        });

    }

});

/* =========================================================
   8. HEALTH CHECK
========================================================= */

app.get('/api/health', (req, res) => {

    res.json({

        success:
            true,

        server:
            "running",

        mongodb:
            mongoose.connection.readyState === 1
                ? "connected"
                : "not connected",

        email1:
            !!EMAIL_1,

        email2:
            !!EMAIL_2

    });

});

/* =========================================================
   START SERVER
========================================================= */

const PORT =
    process.env.PORT || 3000;

app.listen(PORT, () => {

    console.log(
        `🚀 Production server live on port ${PORT}`
    );

});
