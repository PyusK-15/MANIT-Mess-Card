const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const path = require("path");

const app = express();

const MONGO_URI = process.env.MONGO_URI;
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_SENDER_EMAIL_1 = process.env.BREVO_SENDER_EMAIL_1;
const BREVO_SENDER_EMAIL_2 = process.env.BREVO_SENDER_EMAIL_2;

// IMPORTANT:
// Add STAFF_PIN in Render Environment Variables.
// Do NOT put the real PIN in this source code.
const STAFF_PIN = process.env.STAFF_PIN;

// ============================================================
// BASIC CONFIG
// ============================================================

app.use(cors());
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true, limit: "15mb" }));

// ============================================================
// DATABASE CONNECTION
// ============================================================

let cached = global.mongoose;

if (!cached) {
    cached = global.mongoose = {
        conn: null,
        promise: null
    };
}

async function connectDB() {
    if (cached.conn) {
        return cached.conn;
    }

    if (!cached.promise) {
        mongoose.set("bufferCommands", false);

        cached.promise = mongoose.connect(MONGO_URI, {
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 30000
        }).then((mongooseInstance) => {
            console.log("✅ MongoDB Atlas Connected");
            return mongooseInstance;
        });
    }

    try {
        cached.conn = await cached.promise;
    } catch (error) {
        cached.promise = null;
        throw error;
    }

    return cached.conn;
}

// Make sure database is available before API requests.
app.use(async (req, res, next) => {
    try {
        await connectDB();
        next();
    } catch (error) {
        console.error("❌ Database error:", error);

        res.status(500).json({
            success: false,
            message: "Database connection failed."
        });
    }
});

// ============================================================
// BREVO EMAIL
// ============================================================

const BREVO_SENDERS = [
    BREVO_SENDER_EMAIL_1,
    BREVO_SENDER_EMAIL_2
].filter(Boolean);

async function sendBrevoEmail(to, subject, text, html) {
    if (!BREVO_API_KEY) {
        throw new Error("BREVO_API_KEY is not configured.");
    }

    if (BREVO_SENDERS.length === 0) {
        throw new Error("No Brevo sender email is configured.");
    }

    let lastError = null;

    for (let i = 0; i < BREVO_SENDERS.length; i++) {
        const sender = BREVO_SENDERS[i];

        try {
            const response = await fetch(
                "https://api.brevo.com/v3/smtp/email",
                {
                    method: "POST",

                    headers: {
                        "accept": "application/json",
                        "api-key": BREVO_API_KEY,
                        "content-type": "application/json"
                    },

                    body: JSON.stringify({
                        sender: {
                            name: "MANIT Digital Mess Card",
                            email: sender
                        },

                        to: [
                            {
                                email: to
                            }
                        ],

                        subject,
                        textContent: text,
                        htmlContent: html
                    })
                }
            );

            const body = await response.text();

            if (!response.ok) {
                throw new Error(
                    `Brevo ${response.status}: ${body}`
                );
            }

            console.log(
                `📨 Email sent successfully to ${to} using sender ${i + 1}`
            );

            return true;

        } catch (error) {
            lastError = error;

            console.error(
                `❌ Brevo sender ${i + 1} failed:`,
                error.message
            );
        }
    }

    throw new Error(
        `All Brevo senders failed. ${
            lastError ? lastError.message : ""
        }`
    );
}

async function sendOTPEmail(to, otp) {
    return sendBrevoEmail(
        to,

        "MANIT Digital Mess Card - Email Verification OTP",

        `Your MANIT Digital Mess Card verification OTP is ${otp}.

This OTP is valid for 10 minutes.

Do not share this OTP with anyone.`,

        `
        <div style="
            font-family:Arial,sans-serif;
            max-width:600px;
            margin:auto;
            padding:25px;
            background:#f7f9fc;
            border-radius:16px;
        ">

            <h2 style="color:#0a2540;">
                MANIT Digital Mess Card
            </h2>

            <p>
                Your email verification OTP is:
            </p>

            <div style="
                font-size:34px;
                font-weight:800;
                letter-spacing:10px;
                padding:22px;
                background:white;
                text-align:center;
                border-radius:14px;
                margin:20px 0;
            ">
                ${otp}
            </div>

            <p>
                This OTP is valid for
                <b>10 minutes</b>.
            </p>

            <p style="color:#777;">
                If you did not request this OTP,
                you can safely ignore this email.
            </p>

            <hr>

            <p style="
                font-size:12px;
                color:#888;
            ">
                MANIT Digital Mess Card
            </p>

        </div>
        `
    );
}

// ============================================================
// SCHEMAS
// ============================================================

const studentSchema = new mongoose.Schema(
    {
        scholarId: {
            type: String,
            required: true,
            unique: true,
            index: true,
            trim: true
        },

        collegeEmail: {
            type: String,
            required: true,
            unique: true,
            index: true,
            trim: true,
            lowercase: true
        },

        name: {
            type: String,
            required: true,
            trim: true
        },

        room: {
            type: String,
            required: true,
            trim: true
        },

        photo: {
            type: String,
            required: true
        },

        passwordHash: {
            type: String
        },

        // Legacy field kept so old accounts don't break.
        password: {
            type: String
        },

        // OTP verification is the actual account verification.
        emailVerified: {
            type: Boolean,
            default: false
        },

        // Legacy field retained for compatibility with
        // older MongoDB documents. It is NOT used for claiming.
        isVerified: {
            type: Boolean,
            default: true
        },

        lastClaimedMeal: {
            type: String,
            default: ""
        },

        lastClaimedAt: {
            type: Date,
            default: null
        },

        lastClaimedDateKey: {
            type: String,
            default: ""
        },

        // Login session security.
        sessionTokenHash: {
            type: String,
            default: ""
        },

        sessionExpiresAt: {
            type: Date,
            default: null
        }
    },

    {
        timestamps: true
    }
);


const pendingRegistrationSchema = new mongoose.Schema(
    {
        scholarId: {
            type: String,
            required: true,
            unique: true,
            index: true,
            trim: true
        },

        collegeEmail: {
            type: String,
            required: true,
            trim: true,
            lowercase: true
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
        },

        expiresAt: {
            type: Date,

            default: () =>
                new Date(
                    Date.now() + 20 * 60 * 1000
                ),

            index: {
                expires: 0
            }
        }
    },

    {
        timestamps: true
    }
);


const Student =
    mongoose.models.Student ||
    mongoose.model(
        "Student",
        studentSchema
    );


const PendingRegistration =
    mongoose.models.PendingRegistration ||
    mongoose.model(
        "PendingRegistration",
        pendingRegistrationSchema
    );


// ============================================================
// HELPERS
// ============================================================

function cleanScholarId(value) {
    return String(value || "")
        .trim()
        .toLowerCase();
}


function generateOTP() {
    return crypto
        .randomInt(100000, 1000000)
        .toString();
}


function hashOTP(otp) {
    return crypto
        .createHash("sha256")
        .update(String(otp))
        .digest("hex");
}


function generateSessionToken() {
    return crypto
        .randomBytes(48)
        .toString("hex");
}


function hashSessionToken(token) {
    return crypto
        .createHash("sha256")
        .update(String(token))
        .digest("hex");
}


function maskEmail(email) {
    const parts = email.split("@");

    if (parts.length !== 2) {
        return email;
    }

    const name = parts[0];
    const domain = parts[1];

    const visible = name.slice(0, 2);

    return `${visible}******@${domain}`;
}


// ============================================================
// INDIA TIME HELPERS
// ============================================================

function getIndiaParts() {
    const formatter = new Intl.DateTimeFormat(
        "en-GB",
        {
            timeZone: "Asia/Kolkata",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false
        }
    );

    const parts = formatter.formatToParts(
        new Date()
    );

    const result = {};

    for (const part of parts) {
        if (part.type !== "literal") {
            result[part.type] = part.value;
        }
    }

    return result;
}


function getIndiaDateKey() {
    const p = getIndiaParts();

    return `${p.year}-${p.month}-${p.day}`;
}


function getCurrentMealSlot() {
    const p = getIndiaParts();

    const hour = Number(p.hour);

    if (hour >= 6 && hour < 11) {
        return "Breakfast";
    }

    if (hour >= 11 && hour < 16) {
        return "Lunch";
    }

    if (hour >= 16 && hour < 19) {
        return "Snacks";
    }

    if (hour >= 19 && hour < 23) {
        return "Dinner";
    }

    return "Mess Closed";
}


function getIndiaTimeString() {
    const p = getIndiaParts();

    return `${p.hour}:${p.minute}:${p.second}`;
}


// ============================================================
// STUDENT RESPONSE
// ============================================================

function publicStudent(student) {
    return {
        scholarId: student.scholarId,
        collegeEmail: student.collegeEmail,
        name: student.name,
        room: student.room,
        photo: student.photo,
        emailVerified: Boolean(student.emailVerified),

        lastClaimedMeal:
            student.lastClaimedMeal || "",

        lastClaimedAt:
            student.lastClaimedAt || null,

        lastClaimedDateKey:
            student.lastClaimedDateKey || ""
    };
}


// ============================================================
// AUTHENTICATE STUDENT SESSION
// ============================================================

async function authenticateStudent(req) {
    const auth =
        req.headers.authorization || "";

    if (!auth.startsWith("Bearer ")) {
        return null;
    }

    const token =
        auth.substring(7).trim();

    if (!token) {
        return null;
    }

    const tokenHash =
        hashSessionToken(token);

    const student =
        await Student.findOne({
            sessionTokenHash: tokenHash
        });

    if (!student) {
        return null;
    }

    if (
        !student.sessionExpiresAt ||
        student.sessionExpiresAt.getTime() <
            Date.now()
    ) {
        return null;
    }

    return student;
}


// ============================================================
// STAFF AUTHENTICATION
// ============================================================

function verifyStaffPin(req) {
    if (!STAFF_PIN) {
        return false;
    }

    const supplied =
        String(
            req.body?.staffPin || ""
        );

    return supplied === STAFF_PIN;
}


// ============================================================
// HEALTH
// ============================================================

app.get("/api/health", (req, res) => {
    res.json({
        success: true,
        server: "online",
        mongodb:
            mongoose.connection.readyState,
        emailConfigured:
            Boolean(BREVO_API_KEY),
        emailSenders:
            BREVO_SENDERS.length
    });
});


// ============================================================
// REGISTRATION - START
// ============================================================

async function registerStart(req, res) {
    try {
        const {
            scholarId,
            name,
            room,
            password,
            photo
        } = req.body;

        if (
            !scholarId ||
            !name ||
            !room ||
            !password ||
            !photo
        ) {
            return res.status(400).json({
                success: false,
                message:
                    "Please fill all registration fields."
            });
        }

        if (
            String(password).length < 6
        ) {
            return res.status(400).json({
                success: false,
                message:
                    "Password must contain at least 6 characters."
            });
        }

        const cleanId =
            cleanScholarId(scholarId);

        if (!cleanId) {
            return res.status(400).json({
                success: false,
                message:
                    "Please enter your scholar number."
            });
        }

        const collegeEmail =
            `${cleanId}@stu.manit.ac.in`;

        const existingStudent =
            await Student.findOne({
                scholarId: cleanId
            });

        if (existingStudent) {
            return res.status(409).json({
                success: false,
                message:
                    "An account with this scholar number already exists. Please login."
            });
        }

        const now = new Date();

        let pending =
            await PendingRegistration.findOne({
                scholarId: cleanId
            });

        // 60 second resend protection.
        if (
            pending &&
            pending.lastSentAt &&
            now.getTime() -
                pending.lastSentAt.getTime() <
                60 * 1000
        ) {
            return res.status(429).json({
                success: false,
                message:
                    "Please wait 60 seconds before requesting another OTP."
            });
        }

        let sendWindowStartedAt =
            pending?.sendWindowStartedAt ||
            null;

        let sendCount =
            pending?.sendCount || 0;

        if (
            !sendWindowStartedAt ||
            now.getTime() -
                sendWindowStartedAt.getTime() >=
                60 * 60 * 1000
        ) {
            sendWindowStartedAt = now;
            sendCount = 0;
        }

        if (sendCount >= 5) {
            return res.status(429).json({
                success: false,
                message:
                    "Too many OTP requests. Please try again after one hour."
            });
        }

        const otp =
            generateOTP();

        const otpHash =
            hashOTP(otp);

        const passwordHash =
            await bcrypt.hash(
                String(password),
                12
            );

        if (!pending) {
            pending =
                new PendingRegistration({
                    scholarId: cleanId,
                    collegeEmail,
                    name: String(name).trim(),
                    room: String(room).trim(),
                    passwordHash,
                    photo,
                    otpHash,
                    otpExpiresAt:
                        new Date(
                            now.getTime() +
                                10 * 60 * 1000
                        ),
                    attempts: 0,
                    lastSentAt: now,
                    sendWindowStartedAt,
                    sendCount:
                        sendCount + 1,
                    expiresAt:
                        new Date(
                            now.getTime() +
                                20 * 60 * 1000
                        )
                });
        } else {
            pending.collegeEmail =
                collegeEmail;

            pending.name =
                String(name).trim();

            pending.room =
                String(room).trim();

            pending.passwordHash =
                passwordHash;

            pending.photo =
                photo;

            pending.otpHash =
                otpHash;

            pending.otpExpiresAt =
                new Date(
                    now.getTime() +
                        10 * 60 * 1000
                );

            pending.attempts = 0;

            pending.lastSentAt = now;

            pending.sendWindowStartedAt =
                sendWindowStartedAt;

            pending.sendCount =
                sendCount + 1;

            pending.expiresAt =
                new Date(
                    now.getTime() +
                        20 * 60 * 1000
                );
        }

        await pending.save();

        try {
            await sendOTPEmail(
                collegeEmail,
                otp
            );
        } catch (emailError) {
            console.error(
                "❌ OTP email failed:",
                emailError.message
            );

            await PendingRegistration.deleteOne(
                {
                    scholarId: cleanId
                }
            );

            return res.status(500).json({
                success: false,
                message:
                    "Could not send OTP email. Please try again later."
            });
        }

        return res.json({
            success: true,
            message:
                "OTP sent successfully.",
            email:
                maskEmail(collegeEmail)
        });

    } catch (error) {
        console.error(
            "❌ register/start:",
            error
        );

        return res.status(500).json({
            success: false,
            message:
                "Server error while starting registration."
        });
    }
}


app.post(
    "/api/register/start",
    registerStart
);

app.post(
    "/api/send-otp",
    registerStart
);


// ============================================================
// REGISTRATION - VERIFY OTP
// ============================================================

async function registerVerify(req, res) {
    try {
        const {
            scholarId,
            otp
        } = req.body;

        const cleanId =
            cleanScholarId(scholarId);

        if (!cleanId || !otp) {
            return res.status(400).json({
                success: false,
                message:
                    "Scholar number and OTP are required."
            });
        }

        const pending =
            await PendingRegistration.findOne({
                scholarId: cleanId
            });

        if (!pending) {
            return res.status(404).json({
                success: false,
                message:
                    "Registration session expired. Please start registration again."
            });
        }

        if (
            !pending.otpExpiresAt ||
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

        if (pending.attempts >= 5) {
            await PendingRegistration.deleteOne({
                scholarId: cleanId
            });

            return res.status(429).json({
                success: false,
                message:
                    "Too many incorrect OTP attempts. Please start again."
            });
        }

        const suppliedHash =
            hashOTP(
                String(otp).trim()
            );

        if (
            suppliedHash !==
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

        try {
            const student =
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

                    // OTP verification = verified account.
                    emailVerified: true,

                    // Kept for compatibility with old records.
                    isVerified: true,

                    lastClaimedMeal: "",

                    lastClaimedAt: null,

                    lastClaimedDateKey: ""
                });

            await student.save();

        } catch (createError) {
            if (
                createError.code === 11000
            ) {
                return res.status(409).json({
                    success: false,
                    message:
                        "An account with this scholar number or email already exists."
                });
            }

            throw createError;
        }

        await PendingRegistration.deleteOne({
            scholarId: cleanId
        });

        return res.json({
            success: true,
            message:
                "Registration successful! Your email has been verified. You can now login."
        });

    } catch (error) {
        console.error(
            "❌ register/verify:",
            error
        );

        return res.status(500).json({
            success: false,
            message:
                "Server error while verifying OTP."
        });
    }
}


app.post(
    "/api/register/verify",
    registerVerify
);

app.post(
    "/api/verify-otp",
    registerVerify
);


// ============================================================
// RESEND OTP
// ============================================================

async function registerResend(req, res) {
    try {
        const {
            scholarId
        } = req.body;

        const cleanId =
            cleanScholarId(scholarId);

        if (!cleanId) {
            return res.status(400).json({
                success: false,
                message:
                    "Please enter your scholar number."
            });
        }

        const pending =
            await PendingRegistration.findOne({
                scholarId: cleanId
            });

        if (!pending) {
            return res.status(404).json({
                success: false,
                message:
                    "Registration session expired. Please register again."
            });
        }

        const now = new Date();

        if (
            pending.lastSentAt &&
            now.getTime() -
                pending.lastSentAt.getTime() <
                60 * 1000
        ) {
            const remaining =
                Math.ceil(
                    (
                        60 * 1000 -
                        (
                            now.getTime() -
                            pending.lastSentAt.getTime()
                        )
                    ) / 1000
                );

            return res.status(429).json({
                success: false,
                message:
                    `Please wait ${remaining} seconds before requesting another OTP.`
            });
        }

        let sendWindowStartedAt =
            pending.sendWindowStartedAt;

        let sendCount =
            pending.sendCount || 0;

        if (
            !sendWindowStartedAt ||
            now.getTime() -
                sendWindowStartedAt.getTime() >=
                60 * 60 * 1000
        ) {
            sendWindowStartedAt = now;
            sendCount = 0;
        }

        if (sendCount >= 5) {
            return res.status(429).json({
                success: false,
                message:
                    "Too many OTP requests. Please try again after one hour."
            });
        }

        const otp =
            generateOTP();

        try {
            await sendOTPEmail(
                pending.collegeEmail,
                otp
            );
        } catch (emailError) {
            console.error(
                "❌ Resend OTP:",
                emailError.message
            );

            return res.status(500).json({
                success: false,
                message:
                    "Could not send OTP email. Please try again later."
            });
        }

        pending.otpHash =
            hashOTP(otp);

        pending.otpExpiresAt =
            new Date(
                now.getTime() +
                    10 * 60 * 1000
            );

        pending.attempts = 0;

        pending.lastSentAt = now;

        pending.sendWindowStartedAt =
            sendWindowStartedAt;

        pending.sendCount =
            sendCount + 1;

        pending.expiresAt =
            new Date(
                now.getTime() +
                    20 * 60 * 1000
            );

        await pending.save();

        return res.json({
            success: true,
            message:
                "New OTP sent successfully.",
            email:
                maskEmail(
                    pending.collegeEmail
                )
        });

    } catch (error) {
        console.error(
            "❌ register/resend:",
            error
        );

        return res.status(500).json({
            success: false,
            message:
                "Server error while resending OTP."
        });
    }
}


app.post(
    "/api/register/resend",
    registerResend
);


// ============================================================
// LOGIN
// ============================================================

app.post(
    "/api/login",
    async (req, res) => {
        try {
            const {
                scholarId,
                password
            } = req.body;

            const cleanId =
                cleanScholarId(
                    scholarId
                );

            if (
                !cleanId ||
                !password
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Scholar number and password are required."
                });
            }

            const student =
                await Student.findOne({
                    scholarId: cleanId
                });

            if (!student) {
                return res.status(401).json({
                    success: false,
                    message:
                        "Invalid scholar number or password."
                });
            }

            // Only OTP-verified accounts can login.
            if (!student.emailVerified) {
                return res.status(403).json({
                    success: false,
                    message:
                        "Please complete email OTP verification first."
                });
            }

            let passwordCorrect =
                false;

            if (student.passwordHash) {
                passwordCorrect =
                    await bcrypt.compare(
                        String(password),
                        student.passwordHash
                    );

            } else if (student.password) {
                passwordCorrect =
                    student.password ===
                    String(password);

                if (passwordCorrect) {
                    student.passwordHash =
                        await bcrypt.hash(
                            String(password),
                            12
                        );

                    student.password =
                        undefined;

                    await student.save();
                }
            }

            if (!passwordCorrect) {
                return res.status(401).json({
                    success: false,
                    message:
                        "Invalid scholar number or password."
                });
            }

            // Create a fresh login session.
            const sessionToken =
                generateSessionToken();

            student.sessionTokenHash =
                hashSessionToken(
                    sessionToken
                );

            // 12-hour session.
            student.sessionExpiresAt =
                new Date(
                    Date.now() +
                        12 * 60 * 60 * 1000
                );

            await student.save();

            return res.json({
                success: true,

                token:
                    sessionToken,

                student:
                    publicStudent(student)
            });

        } catch (error) {
            console.error(
                "❌ login:",
                error
            );

            return res.status(500).json({
                success: false,
                message:
                    "Server error during login."
            });
        }
    }
);


// ============================================================
// LOGOUT
// ============================================================

app.post(
    "/api/logout",
    async (req, res) => {
        try {
            const student =
                await authenticateStudent(
                    req
                );

            if (student) {
                student.sessionTokenHash =
                    "";

                student.sessionExpiresAt =
                    null;

                await student.save();
            }

            return res.json({
                success: true
            });

        } catch (error) {
            return res.json({
                success: true
            });
        }
    }
);


// ============================================================
// STUDENT STATUS
// ============================================================

app.get(
    "/api/status",
    async (req, res) => {
        try {
            const student =
                await authenticateStudent(
                    req
                );

            if (!student) {
                return res.status(401).json({
                    success: false,
                    message:
                        "Session expired. Please login again."
                });
            }

            const today =
                getIndiaDateKey();

            const claimed =
                student.lastClaimedDateKey ===
                    today &&
                Boolean(
                    student.lastClaimedMeal
                );

            const currentMeal =
                getCurrentMealSlot();

            return res.json({
                success: true,

                student:
                    publicStudent(student),

                claimed,

                claimedMeal:
                    claimed
                        ? student.lastClaimedMeal
                        : "",

                claimedAt:
                    claimed
                        ? student.lastClaimedAt
                        : null,

                activeSlot:
                    currentMeal,

                indiaDate:
                    today,

                indiaTime:
                    getIndiaTimeString(),

                serverTime:
                    new Date().toISOString()
            });

        } catch (error) {
            console.error(
                "❌ status:",
                error
            );

            return res.status(500).json({
                success: false,
                message:
                    "Server error while checking status."
            });
        }
    }
);


// ============================================================
// CLAIM MEAL
// ============================================================

app.post(
    "/api/claim",
    async (req, res) => {
        try {
            const student =
                await authenticateStudent(
                    req
                );

            if (!student) {
                return res.status(401).json({
                    success: false,
                    message:
                        "Your session has expired. Please login again."
                });
            }

            if (!student.emailVerified) {
                return res.status(403).json({
                    success: false,
                    message:
                        "Email verification is required."
                });
            }

            const meal =
                getCurrentMealSlot();

            if (meal === "Mess Closed") {
                return res.status(400).json({
                    success: false,
                    message:
                        "Mess service is currently closed."
                });
            }

            const today =
                getIndiaDateKey();

            /*
             * IMPORTANT:
             *
             * This is checked on the SERVER.
             * The frontend button is NOT the security mechanism.
             */

            if (
                student.lastClaimedDateKey ===
                    today &&
                student.lastClaimedMeal ===
                    meal
            ) {
                return res.status(409).json({
                    success: false,
                    alreadyClaimed: true,
                    message:
                        `${meal} has already been received today.`
                });
            }

            /*
             * Atomic update:
             *
             * Only update if this exact meal
             * has not already been claimed today.
             *
             * This also protects against rapid
             * double-click / simultaneous requests.
             */

            const updatedStudent =
                await Student.findOneAndUpdate(
                    {
                        _id: student._id,

                        emailVerified: true,

                        $nor: [
                            {
                                lastClaimedDateKey:
                                    today,

                                lastClaimedMeal:
                                    meal
                            }
                        ]
                    },

                    {
                        $set: {
                            lastClaimedMeal:
                                meal,

                            lastClaimedAt:
                                new Date(),

                            lastClaimedDateKey:
                                today
                        }
                    },

                    {
                        new: true
                    }
                );

            if (!updatedStudent) {
                return res.status(409).json({
                    success: false,
                    alreadyClaimed: true,
                    message:
                        `${meal} has already been received today.`
                });
            }

            return res.json({
                success: true,

                message:
                    `${meal} received successfully.`,

                meal,

                claimedAt:
                    updatedStudent.lastClaimedAt,

                student: {
                    name:
                        updatedStudent.name,

                    scholarId:
                        updatedStudent.scholarId,

                    room:
                        updatedStudent.room
                }
            });

        } catch (error) {
            console.error(
                "❌ claim:",
                error
            );

            return res.status(500).json({
                success: false,
                message:
                    "Server error while claiming meal."
            });
        }
    }
);


// ============================================================
// STAFF RESET ONE
// ============================================================

app.post(
    "/api/reset-one",
    async (req, res) => {
        try {
            if (!verifyStaffPin(req)) {
                return res.status(401).json({
                    success: false,
                    message:
                        "Invalid staff PIN."
                });
            }

            const cleanId =
                cleanScholarId(
                    req.body.scholarId
                );

            if (!cleanId) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Scholar number is required."
                });
            }

            const student =
                await Student.findOne({
                    scholarId: cleanId
                });

            if (!student) {
                return res.status(404).json({
                    success: false,
                    message:
                        "Student not found."
                });
            }

            student.lastClaimedMeal =
                "";

            student.lastClaimedAt =
                null;

            student.lastClaimedDateKey =
                "";

            await student.save();

            return res.json({
                success: true,
                message:
                    `Meal status reset for ${student.name}.`
            });

        } catch (error) {
            console.error(
                "❌ reset-one:",
                error
            );

            return res.status(500).json({
                success: false,
                message:
                    "Server error while resetting student."
            });
        }
    }
);


// ============================================================
// STAFF RESET ALL
// ============================================================

app.post(
    "/api/reset-all",
    async (req, res) => {
        try {
            if (!verifyStaffPin(req)) {
                return res.status(401).json({
                    success: false,
                    message:
                        "Invalid staff PIN."
                });
            }

            await Student.updateMany(
                {},

                {
                    $set: {
                        lastClaimedMeal: "",
                        lastClaimedAt: null,
                        lastClaimedDateKey: ""
                    }
                }
            );

            return res.json({
                success: true,
                message:
                    "All student meal statuses have been reset."
            });

        } catch (error) {
            console.error(
                "❌ reset-all:",
                error
            );

            return res.status(500).json({
                success: false,
                message:
                    "Server error while resetting all students."
            });
        }
    }
);


// ============================================================
// SERVE FRONTEND
// ============================================================

app.use(
    express.static(
        path.join(
            __dirname,
            "public"
        )
    )
);


app.get(
    "/",
    (req, res) => {
        res.sendFile(
            path.join(
                __dirname,
                "public",
                "index.html"
            )
        );
    }
);


// ============================================================
// API 404
// ============================================================

app.use(
    "/api",
    (req, res) => {
        res.status(404).json({
            success: false,
            message:
                `API endpoint not found: ${req.method} ${req.originalUrl}`
        });
    }
);


// ============================================================
// ERROR HANDLER
// ============================================================

app.use(
    (error, req, res, next) => {
        console.error(
            "❌ Server error:",
            error
        );

        res.status(500).json({
            success: false,
            message:
                "Internal server error."
        });
    }
);


// ============================================================
// START SERVER
// ============================================================

if (process.env.VERCEL) {
    module.exports = app;
} else {
    const PORT =
        process.env.PORT || 3000;

    connectDB()
        .then(() => {
            app.listen(
                PORT,
                () => {
                    console.log(
                        `🚀 MANIT Mess Card server running on port ${PORT}`
                    );
                }
            );
        })
        .catch((error) => {
            console.error(
                "❌ Failed to start server:",
                error
            );

            process.exit(1);
        });
}
