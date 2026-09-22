const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const nodemailer = require('nodemailer');
const bcrypt = require('bcryptjs');

const app = express();

app.use(express.json({ limit: '15mb' }));
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

/* =========================================================
   DATABASE
   ========================================================= */

const MONGO_URI =
    process.env.MONGO_URI ||
    'mongodb+srv://pyus1528_db_user:Piyush123@manit-mess.y5xx5ki.mongodb.net/manitMessDB?retryWrites=true&w=majority';

mongoose.connect(MONGO_URI, {
    maxPoolSize: 50,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000
})
.then(() => console.log("✅ MongoDB Atlas Connected Successfully"))
.catch(err => console.error("❌ MongoDB Connection Error:", err.message));


/* =========================================================
   EMAIL CONFIGURATION
   =========================================================

   For now, put your Gmail sender credentials here.

   IMPORTANT:
   Use a Gmail APP PASSWORD, NOT your normal Gmail password.

   Example:

   const EMAIL_USER = 'yourmesscard@gmail.com';
   const EMAIL_PASS = 'abcdefghijklmnop';

   Do NOT put your student's MANIT password here.
   This is only the account used to SEND OTP emails.
   ========================================================= */

const EMAIL_1 = process.env.EMAIL_1;
const PASS_1 = process.env.PASS_1;

const EMAIL_2 = process.env.EMAIL_2;
const PASS_2 = process.env.PASS_2;

let transporter = null;

if (EMAIL_USER && EMAIL_PASS) {
    transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: EMAIL_USER,
            pass: EMAIL_PASS
        }
    });

    transporter.verify((error) => {
        if (error) {
            console.error("❌ Email configuration error:", error.message);
        } else {
            console.log("✅ Email service is ready");
        }
    });
} else {
    console.log("⚠️ EMAIL_USER / EMAIL_PASS not configured yet.");
}


/* =========================================================
   STUDENT SCHEMA
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

    passwordHash: {
        type: String,
        required: true
    },

    photo: {
        type: String,
        required: true
    },

    // Email OTP verification
    emailVerified: {
        type: Boolean,
        default: false
    },

    // Kept for compatibility with your existing card UI.
    // This can later be used for an optional physical MANIT ID check.
    isVerified: {
        type: Boolean,
        default: true
    },

    lastClaimedMeal: {
        type: String,
        default: ''
    }

}, { timestamps: true });


const Student = mongoose.model('Student', studentSchema);


/* =========================================================
   TEMPORARY OTP REGISTRATION SCHEMA
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

    otpAttempts: {
        type: Number,
        default: 0
    },

    lastOtpSentAt: {
        type: Date,
        required: true
    }

}, { timestamps: true });

const PendingRegistration =
    mongoose.model('PendingRegistration', pendingRegistrationSchema);


/* =========================================================
   HELPERS
   ========================================================= */

function cleanScholarId(value) {
    return String(value || '').trim().toLowerCase();
}


function isValidScholarId(scholarId) {
    /*
       MANIT Scholar IDs normally consist of letters/numbers.
       We deliberately do not enforce a specific length here.
    */

    return /^[a-z0-9]+$/i.test(scholarId);
}


function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}


function getCurrentMealSlot() {

    const d = new Date(
        new Date().toLocaleString("en-US", {
            timeZone: "Asia/Kolkata"
        })
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
    }

    else if (timeStr >= "12:30" && timeStr < "15:30") {
        mealSlot = "Lunch";
    }

    else if (timeStr >= "17:00" && timeStr < "18:30") {
        mealSlot = "Snacks";
    }

    else if (timeStr >= "19:30" && timeStr < "22:30") {
        mealSlot = "Dinner";
    }

    else {
        mealSlot = "Special / Off-Peak Service";
    }

    return {
        active: true,
        id: `${dateStr}-${mealSlot}`,
        name: mealSlot
    };
}


/* =========================================================
   SEND OTP EMAIL
   ========================================================= */

async function sendOTPEmail(email, otp, scholarId) {

    if (!transporter) {
        throw new Error(
            "Email service is not configured. Add EMAIL_USER and EMAIL_PASS."
        );
    }

    const mailOptions = {

        from: `"MANIT Digital Mess Card" <${EMAIL_USER}>`,

        to: email,

        subject: "MANIT Mess Card - Email Verification OTP",

        text:
`MANIT Digital Mess Card

Dear Student,

Your OTP for registering your MANIT Digital Mess Card is:

${otp}

Scholar ID: ${scholarId}

This OTP is valid for 10 minutes.

If you did not request this OTP, please ignore this email.

Regards,
MANIT Digital Mess Card System`,

        html: `
        <div style="
            font-family: Arial, sans-serif;
            max-width: 600px;
            margin: auto;
            padding: 25px;
            border: 1px solid #e2e8f0;
            border-radius: 15px;
        ">

            <h2 style="color:#0a2540;">
                MANIT Digital Mess Card
            </h2>

            <p>
                Your email verification OTP is:
            </p>

            <div style="
                font-size:32px;
                font-weight:bold;
                letter-spacing:8px;
                color:#2563eb;
                padding:15px;
                text-align:center;
                background:#f8fafc;
                border-radius:10px;
            ">
                ${otp}
            </div>

            <p>
                <strong>Scholar ID:</strong> ${scholarId}
            </p>

            <p>
                This OTP will expire in <strong>10 minutes</strong>.
            </p>

            <p style="color:#64748b;font-size:13px;">
                If you did not request this verification, you can safely
                ignore this email.
            </p>

        </div>
        `
    };

    await transporter.sendMail(mailOptions);
}


/* =========================================================
   1. START REGISTRATION
   ========================================================= */

app.post('/api/register/start', async (req, res) => {

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
                message: "All fields are required."
            });
        }


        const cleanId = cleanScholarId(scholarId);


        if (!isValidScholarId(cleanId)) {

            return res.status(400).json({
                success: false,
                message: "Invalid Scholar Number."
            });
        }


        if (password.length < 6) {

            return res.status(400).json({
                success: false,
                message: "Password must contain at least 6 characters."
            });
        }


        const collegeEmail =
            `${cleanId}@stu.manit.ac.in`;


        /* Check permanent account */

        const existingStudent =
            await Student.findOne({
                scholarId: cleanId
            });

        if (existingStudent) {

            return res.status(409).json({
                success: false,
                message:
                    "An account already exists for this Scholar Number. Please log in."
            });
        }


        /* Check whether an OTP was recently sent */

        const existingPending =
            await PendingRegistration.findOne({
                scholarId: cleanId
            });


        if (existingPending) {

            const secondsSinceLastOTP =
                (Date.now() -
                    existingPending.lastOtpSentAt.getTime()) / 1000;

            if (secondsSinceLastOTP < 60) {

                const remaining =
                    Math.ceil(60 - secondsSinceLastOTP);

                return res.status(429).json({
                    success: false,
                    message:
                        `Please wait ${remaining} seconds before requesting another OTP.`
                });
            }
        }


        /* Generate OTP */

        const otp = generateOTP();

        const otpHash =
            await bcrypt.hash(otp, 10);

        const passwordHash =
            await bcrypt.hash(password, 12);


        const now = new Date();

        const otpExpiresAt =
            new Date(
                now.getTime() + 10 * 60 * 1000
            );


        /* Save/update pending registration */

        await PendingRegistration.findOneAndUpdate(

            { scholarId: cleanId },

            {
                scholarId: cleanId,

                collegeEmail,

                name: name.trim(),

                room: room.trim(),

                passwordHash,

                photo,

                otpHash,

                otpExpiresAt,

                otpAttempts: 0,

                lastOtpSentAt: now
            },

            {
                upsert: true,
                new: true,
                setDefaultsOnInsert: true
            }
        );


        /* Send OTP */

        try {

            await sendOTPEmail(
                collegeEmail,
                otp,
                cleanId
            );

        } catch (emailError) {

            console.error(
                "OTP Email Error:",
                emailError
            );

            await PendingRegistration.deleteOne({
                scholarId: cleanId
            });

            return res.status(500).json({
                success: false,
                message:
                    "Could not send OTP. Please check the email service configuration."
            });
        }


        return res.status(200).json({

            success: true,

            message:
                `OTP sent to ${cleanId.slice(0, 2)}******@stu.manit.ac.in`,

            scholarId: cleanId,

            emailMasked:
                `${cleanId.slice(0, 2)}******@stu.manit.ac.in`

        });

    }

    catch (err) {

        console.error(
            "Registration Start Error:",
            err
        );

        return res.status(500).json({
            success: false,
            message: "Unable to start registration."
        });
    }
});


/* =========================================================
   2. VERIFY OTP
   ========================================================= */

app.post('/api/register/verify', async (req, res) => {

    try {

        const {
            scholarId,
            otp
        } = req.body;


        if (!scholarId || !otp) {

            return res.status(400).json({
                success: false,
                message: "Scholar Number and OTP are required."
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
                    "No pending registration found. Please request a new OTP."
            });
        }


        /* Check expiry */

        if (new Date() > pending.otpExpiresAt) {

            await PendingRegistration.deleteOne({
                scholarId: cleanId
            });

            return res.status(400).json({
                success: false,
                message:
                    "OTP has expired. Please request a new OTP."
            });
        }


        /* Check attempts */

        if (pending.otpAttempts >= 5) {

            await PendingRegistration.deleteOne({
                scholarId: cleanId
            });

            return res.status(429).json({
                success: false,
                message:
                    "Too many incorrect attempts. Please request a new OTP."
            });
        }


        /* Compare OTP */

        const correctOTP =
            await bcrypt.compare(
                String(otp).trim(),
                pending.otpHash
            );


        if (!correctOTP) {

            pending.otpAttempts += 1;

            await pending.save();

            const remaining =
                5 - pending.otpAttempts;

            return res.status(400).json({
                success: false,
                message:
                    `Incorrect OTP. ${remaining} attempt(s) remaining.`
            });
        }


        /* Make absolutely sure another account wasn't created */

        const existingStudent =
            await Student.findOne({
                scholarId: cleanId
            });

        if (existingStudent) {

            await PendingRegistration.deleteOne({
                scholarId: cleanId
            });

            return res.status(409).json({
                success: false,
                message:
                    "An account already exists for this Scholar Number."
            });
        }


        /* Create permanent account */

        const newStudent =
            new Student({

                scholarId:
                    pending.scholarId,

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
                   Email verification is now the registration
                   verification. Physical verification is no
                   longer required before using the card.
                */
                isVerified:
                    true,

                lastClaimedMeal:
                    ''
            });


        await newStudent.save();


        /* Remove temporary registration */

        await PendingRegistration.deleteOne({
            scholarId: cleanId
        });


        return res.status(201).json({

            success: true,

            message:
                "Email verified! Your MANIT Digital Mess Card account has been created.",

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
                    newStudent.isVerified
            }

        });

    }

    catch (err) {

        console.error(
            "OTP Verification Error:",
            err
        );

        return res.status(500).json({
            success: false,
            message: "OTP verification failed."
        });
    }
});


/* =========================================================
   3. RESEND OTP
   ========================================================= */

app.post('/api/register/resend', async (req, res) => {

    try {

        const {
            scholarId
        } = req.body;


        if (!scholarId) {

            return res.status(400).json({
                success: false,
                message: "Scholar Number is required."
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
                    "No pending registration found. Please start registration again."
            });
        }


        /* 60 second cooldown */

        const secondsSinceLastOTP =
            (Date.now() -
                pending.lastOtpSentAt.getTime()) / 1000;


        if (secondsSinceLastOTP < 60) {

            const remaining =
                Math.ceil(60 - secondsSinceLastOTP);

            return res.status(429).json({
                success: false,
                message:
                    `Please wait ${remaining} seconds before requesting another OTP.`
            });
        }


        const otp =
            generateOTP();


        const otpHash =
            await bcrypt.hash(otp, 10);


        pending.otpHash =
            otpHash;

        pending.otpExpiresAt =
            new Date(
                Date.now() + 10 * 60 * 1000
            );

        pending.otpAttempts =
            0;

        pending.lastOtpSentAt =
            new Date();


        await pending.save();


        try {

            await sendOTPEmail(
                pending.collegeEmail,
                otp,
                cleanId
            );

        } catch (emailError) {

            console.error(
                "Resend Email Error:",
                emailError
            );

            return res.status(500).json({
                success: false,
                message:
                    "Could not send the new OTP."
            });
        }


        return res.json({

            success: true,

            message:
                `A new OTP has been sent to ${cleanId.slice(0, 2)}******@stu.manit.ac.in`
        });

    }

    catch (err) {

        console.error(
            "Resend OTP Error:",
            err
        );

        return res.status(500).json({
            success: false,
            message: "Could not resend OTP."
        });
    }
});


/* =========================================================
   4. STUDENT LOGIN
   ========================================================= */

app.post('/api/login', async (req, res) => {

    try {

        const {
            scholarId,
            password
        } = req.body;


        if (!scholarId || !password) {

            return res.status(400).json({
                success: false,
                message:
                    "Scholar ID and password are required."
            });
        }


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


        const passwordCorrect =
            await bcrypt.compare(
                password,
                student.passwordHash
            );


        if (!passwordCorrect) {

            return res.status(401).json({
                success: false,
                message:
                    "Invalid Scholar ID or password."
            });
        }


        if (!student.emailVerified) {

            return res.status(403).json({
                success: false,
                message:
                    "Please verify your MANIT email before logging in."
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
                    student.isVerified
            }

        });

    }

    catch (err) {

        console.error(
            "Login Error:",
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
   5. STATUS POLL
   ========================================================= */

app.get('/api/status/:scholarId', async (req, res) => {

    try {

        const slot =
            getCurrentMealSlot();


        const student =
            await Student.findOne({
                scholarId:
                    cleanScholarId(req.params.scholarId)
            }).lean();


        if (!student) {

            return res.json({
                activeSlot: slot.name,
                claimed: false,
                isVerified: false
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
                student.isVerified

        });

    }

    catch (err) {

        console.error(
            "Status Error:",
            err
        );

        return res.status(500).json({
            error:
                "Check failed"
        });
    }
});


/* =========================================================
   6. STAFF COUNTER SCANNER
   ========================================================= */

app.post('/api/scan', async (req, res) => {

    try {

        if (!req.body.scholarId) {

            return res.json({
                status: 'error',
                message:
                    "Invalid QR code"
            });
        }


        const cleanId =
            cleanScholarId(req.body.scholarId);


        const slot =
            getCurrentMealSlot();


        const student =
            await Student.findOne({
                scholarId: cleanId
            });


        if (!student) {

            return res.json({
                status: 'error',
                message:
                    "Unregistered Student"
            });
        }


        /* OTP/email verification is required */

        if (!student.emailVerified) {

            return res.json({

                status:
                    'denied',

                name:
                    student.name,

                room:
                    student.room,

                message:
                    "MANIT email is not verified."
            });
        }


        /* Check duplicate meal claim */

        if (student.lastClaimedMeal === slot.id) {

            return res.json({

                status:
                    'denied',

                name:
                    student.name,

                room:
                    student.room,

                message:
                    "Student already received this meal."
            });
        }


        /* Allow meal */

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
                false
        });

    }

    catch (err) {

        console.error(
            "Scan Error:",
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
   7. STAFF RESET ONE
   ========================================================= */

app.post('/api/reset-one', async (req, res) => {

    try {

        const {
            scholarId,
            staffPin
        } = req.body;


        if (staffPin !== 'manitH10') {

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
                        cleanScholarId(scholarId)
                },

                {
                    $set: {
                        lastClaimedMeal: ''
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

    }

    catch (err) {

        console.error(
            "Reset One Error:",
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
   8. STAFF RESET ALL
   ========================================================= */

app.post('/api/reset-all', async (req, res) => {

    try {

        const {
            staffPin
        } = req.body;


        if (staffPin !== 'manitH10') {

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
                    lastClaimedMeal: ''
                }
            }
        );


        return res.json({

            success:
                true,

            message:
                "All student cards reset successfully!"
        });

    }

    catch (err) {

        console.error(
            "Reset All Error:",
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
   HEALTH CHECK
   ========================================================= */

app.get('/api/health', (req, res) => {

    res.json({

        success:
            true,

        message:
            "MANIT Digital Mess Card server is running."

    });

});


/* =========================================================
   SERVER
   ========================================================= */

const PORT =
    process.env.PORT || 3000;


app.listen(
    PORT,
    () => {
        console.log(
            `🚀 Production server live on port ${PORT}`
        );
    }
);
