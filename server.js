const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const path = require("path");

const app = express();

app.use(cors());
app.use(express.json({ limit: "12mb" }));
app.use(express.urlencoded({ extended: true, limit: "12mb" }));

// ============================================================
// CONFIG
// ============================================================

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || "";

const BREVO_API_KEY = process.env.BREVO_API_KEY || "";
const BREVO_SENDER_EMAIL_1 = process.env.BREVO_SENDER_EMAIL_1 || "";
const BREVO_SENDER_EMAIL_2 = process.env.BREVO_SENDER_EMAIL_2 || "";

const STAFF_PIN = process.env.STAFF_PIN || "";

const SESSION_DURATION_MS = 12 * 60 * 60 * 1000;
const MEAL_COOLDOWN_MS = 2 * 60 * 60 * 1000;

const OTP_EXPIRY_MS = 10 * 60 * 1000;
const PENDING_REGISTRATION_EXPIRY_MS = 20 * 60 * 1000;

const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_OTP_SENDS_PER_HOUR = 5;
const MAX_OTP_VERIFY_ATTEMPTS = 5;

// ============================================================
// DATABASE CONNECTION
// ============================================================

let mongoConnectionPromise = null;

async function connectDB() {
  if (!MONGO_URI) {
    throw new Error("MONGO_URI is not configured");
  }

  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  if (!mongoConnectionPromise) {
    mongoConnectionPromise = mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 10000,
    });
  }

  try {
    await mongoConnectionPromise;
    return mongoose.connection;
  } catch (error) {
    mongoConnectionPromise = null;
    throw error;
  }
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
      trim: true,
      lowercase: true,
    },

    collegeEmail: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },

    name: {
      type: String,
      required: true,
      trim: true,
    },

    room: {
      type: String,
      required: true,
      trim: true,
    },

    photo: {
      type: String,
      default: "",
    },

    passwordHash: {
      type: String,
      required: true,
    },

    // Kept only for compatibility with older records.
    password: {
      type: String,
      default: "",
    },

    // OTP verification is the only verification.
    emailVerified: {
      type: Boolean,
      default: false,
    },

    // Session authentication
    sessionTokenHash: {
      type: String,
      default: "",
    },

    sessionExpiresAt: {
      type: Date,
      default: null,
    },

    // Meal claim
    lastClaimedMeal: {
      type: String,
      default: "",
    },

    lastClaimedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

const pendingRegistrationSchema = new mongoose.Schema(
  {
    scholarId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    collegeEmail: {
      type: String,
      required: true,
    },

    name: {
      type: String,
      required: true,
    },

    room: {
      type: String,
      required: true,
    },

    photo: {
      type: String,
      default: "",
    },

    passwordHash: {
      type: String,
      required: true,
    },

    otpHash: {
      type: String,
      required: true,
    },

    otpExpiresAt: {
      type: Date,
      required: true,
    },

    pendingExpiresAt: {
      type: Date,
      required: true,
      index: true,
    },

    lastOtpSentAt: {
      type: Date,
      default: null,
    },

    otpSendCount: {
      type: Number,
      default: 1,
    },

    otpSendWindowStartedAt: {
      type: Date,
      default: Date.now,
    },

    verifyAttempts: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

pendingRegistrationSchema.index(
  { pendingExpiresAt: 1 },
  { expireAfterSeconds: 0 }
);

const Student =
  mongoose.models.Student ||
  mongoose.model("Student", studentSchema);

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

function normalizeText(value) {
  return String(value || "").trim();
}

function hashValue(value) {
  return crypto
    .createHash("sha256")
    .update(String(value))
    .digest("hex");
}

function generateOtp() {
  return String(
    Math.floor(100000 + Math.random() * 900000)
  );
}

function generateSessionToken() {
  return crypto.randomBytes(32).toString("hex");
}

function getBearerToken(req) {
  const header = req.headers.authorization || "";

  if (!header.startsWith("Bearer ")) {
    return "";
  }

  return header.slice(7).trim();
}

function maskEmail(email) {
  if (!email || !email.includes("@")) {
    return email || "";
  }

  const [local, domain] = email.split("@");

  if (local.length <= 2) {
    return `${local[0] || "*"}***@${domain}`;
  }

  return `${local.slice(0, 2)}***@${domain}`;
}

function studentResponse(student) {
  return {
    scholarId: student.scholarId,
    collegeEmail: student.collegeEmail,
    name: student.name,
    room: student.room,
    photo: student.photo || "",
    emailVerified: Boolean(student.emailVerified),
    lastClaimedAt: student.lastClaimedAt || null,
  };
}

function cooldownInfo(lastClaimedAt, now = new Date()) {
  if (!lastClaimedAt) {
    return {
      claimed: false,
      canClaim: true,
      cooldownRemainingMs: 0,
      nextClaimAt: null,
    };
  }

  const claimedTime = new Date(lastClaimedAt).getTime();

  if (Number.isNaN(claimedTime)) {
    return {
      claimed: false,
      canClaim: true,
      cooldownRemainingMs: 0,
      nextClaimAt: null,
    };
  }

  const nextClaimTime =
    claimedTime + MEAL_COOLDOWN_MS;

  const remaining =
    Math.max(0, nextClaimTime - now.getTime());

  return {
    claimed: remaining > 0,
    canClaim: remaining <= 0,
    cooldownRemainingMs: remaining,
    nextClaimAt:
      remaining > 0
        ? new Date(nextClaimTime).toISOString()
        : null,
  };
}

// ============================================================
// BREVO EMAIL
// ============================================================

async function sendBrevoEmail({
  to,
  subject,
  htmlContent,
  textContent,
}) {
  if (!BREVO_API_KEY) {
    throw new Error("BREVO_API_KEY is not configured");
  }

  const senders = [
    BREVO_SENDER_EMAIL_1,
    BREVO_SENDER_EMAIL_2,
  ].filter(Boolean);

  if (senders.length === 0) {
    throw new Error(
      "No Brevo sender email is configured"
    );
  }

  let lastError = null;

  for (const senderEmail of senders) {
    try {
      const response = await fetch(
        "https://api.brevo.com/v3/smtp/email",
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "api-key": BREVO_API_KEY,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            sender: {
              email: senderEmail,
              name: "MANIT Digital Mess Card",
            },
            to: [
              {
                email: to,
              },
            ],
            subject,
            htmlContent,
            textContent,
          }),
        }
      );

      const responseText = await response.text();

      if (!response.ok) {
        lastError = new Error(
          `Brevo ${response.status}: ${responseText}`
        );
        continue;
      }

      return true;
    } catch (error) {
      lastError = error;
    }
  }

  throw (
    lastError ||
    new Error("Unable to send email")
  );
}

async function sendOTPEmail(email, otp) {
  const htmlContent = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
</head>
<body style="font-family:Arial,sans-serif;background:#f5f7fb;padding:30px;">
  <div style="max-width:520px;margin:auto;background:white;border-radius:18px;padding:30px;">
    <h2 style="margin-top:0;">MANIT Digital Mess Card</h2>

    <p>Your email verification OTP is:</p>

    <div style="
      font-size:34px;
      font-weight:800;
      letter-spacing:8px;
      padding:20px;
      text-align:center;
      background:#f1f4f9;
      border-radius:14px;
      margin:20px 0;
    ">
      ${otp}
    </div>

    <p>This OTP expires in <strong>10 minutes</strong>.</p>

    <p style="color:#666;">
      If you did not request this verification, you can ignore this email.
    </p>
  </div>
</body>
</html>
`;

  const textContent = `
MANIT Digital Mess Card

Your verification OTP is: ${otp}

This OTP expires in 10 minutes.
`;

  await sendBrevoEmail({
    to: email,
    subject: "MANIT Digital Mess Card - Verification OTP",
    htmlContent,
    textContent,
  });
}

// ============================================================
// AUTHENTICATION
// ============================================================

async function authenticateStudent(req) {
  const token = getBearerToken(req);

  if (!token) {
    return null;
  }

  const tokenHash = hashValue(token);

  const student = await Student.findOne({
    sessionTokenHash: tokenHash,
    sessionExpiresAt: {
      $gt: new Date(),
    },
    emailVerified: true,
  });

  return student;
}

function requireStaff(req, res, next) {
  const token = getBearerToken(req);

  if (!token || !STAFF_PIN) {
    return res.status(401).json({
      success: false,
      message: "Staff authentication required.",
    });
  }

  const expected = hashValue(
    `${STAFF_PIN}:MANIT-MESS-STAFF`
  );

  const provided = hashValue(
    `${token}:MANIT-MESS-STAFF`
  );

  if (provided !== expected) {
    return res.status(401).json({
      success: false,
      message: "Invalid staff session.",
    });
  }

  next();
}

// ============================================================
// HEALTH
// ============================================================

app.get("/api/health", async (req, res) => {
  try {
    await connectDB();

    res.json({
      success: true,
      status: "online",
      database: "connected",
      time: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      status: "error",
      database: "disconnected",
    });
  }
});

// ============================================================
// REGISTRATION - START
// ============================================================

app.post("/api/register/start", async (req, res) => {
  try {
    await connectDB();

    const scholarId = cleanScholarId(req.body.scholarId);
    const name = normalizeText(req.body.name);
    const room = normalizeText(req.body.room);
    const password = String(req.body.password || "");
    const photo = String(req.body.photo || "");

    if (!scholarId || !name || !room || !password) {
      return res.status(400).json({
        success: false,
        message:
          "Scholar ID, name, room and password are required.",
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        message:
          "Password must contain at least 6 characters.",
      });
    }

    const collegeEmail =
      `${scholarId}@stu.manit.ac.in`;

    const existingStudent = await Student.findOne({
      scholarId,
    });

    if (existingStudent) {
      return res.status(409).json({
        success: false,
        message:
          "This Scholar ID is already registered.",
      });
    }

    const now = new Date();

    const existingPending =
      await PendingRegistration.findOne({
        scholarId,
      });

    if (
      existingPending &&
      existingPending.lastOtpSentAt &&
      now.getTime() -
        new Date(
          existingPending.lastOtpSentAt
        ).getTime() <
        OTP_RESEND_COOLDOWN_MS
    ) {
      const remaining = Math.ceil(
        (
          OTP_RESEND_COOLDOWN_MS -
          (
            now.getTime() -
            new Date(
              existingPending.lastOtpSentAt
            ).getTime()
          )
        ) / 1000
      );

      return res.status(429).json({
        success: false,
        message:
          `Please wait ${remaining} seconds before requesting another OTP.`,
        cooldownSeconds: remaining,
      });
    }

    const passwordHash =
      await bcrypt.hash(password, 12);

    const otp = generateOtp();

    const pending = existingPending || new PendingRegistration();

    pending.scholarId = scholarId;
    pending.collegeEmail = collegeEmail;
    pending.name = name;
    pending.room = room;
    pending.photo = photo;
    pending.passwordHash = passwordHash;
    pending.otpHash = hashValue(otp);
    pending.otpExpiresAt = new Date(
      now.getTime() + OTP_EXPIRY_MS
    );
    pending.pendingExpiresAt = new Date(
      now.getTime() +
        PENDING_REGISTRATION_EXPIRY_MS
    );
    pending.lastOtpSentAt = now;

    if (!existingPending) {
      pending.otpSendCount = 1;
      pending.otpSendWindowStartedAt = now;
      pending.verifyAttempts = 0;
    } else {
      const windowAge =
        now.getTime() -
        new Date(
          pending.otpSendWindowStartedAt
        ).getTime();

      if (windowAge >= 60 * 60 * 1000) {
        pending.otpSendCount = 1;
        pending.otpSendWindowStartedAt = now;
      } else {
        if (
          pending.otpSendCount >=
          MAX_OTP_SENDS_PER_HOUR
        ) {
          return res.status(429).json({
            success: false,
            message:
              "Too many OTP requests. Please try again later.",
          });
        }

        pending.otpSendCount += 1;
      }
    }

    await pending.save();

    await sendOTPEmail(
      collegeEmail,
      otp
    );

    res.json({
      success: true,
      message:
        "OTP sent to your MANIT student email.",
      scholarId,
      email: maskEmail(collegeEmail),
    });
  } catch (error) {
    console.error(
      "REGISTER START ERROR:",
      error
    );

    res.status(500).json({
      success: false,
      message:
        "Unable to start registration. Please try again.",
    });
  }
});

// ============================================================
// REGISTRATION - VERIFY
// ============================================================

app.post("/api/register/verify", async (req, res) => {
  try {
    await connectDB();

    const scholarId = cleanScholarId(
      req.body.scholarId
    );

    const otp = String(
      req.body.otp || ""
    ).trim();

    if (!scholarId || !/^\d{6}$/.test(otp)) {
      return res.status(400).json({
        success: false,
        message: "Enter the 6-digit OTP.",
      });
    }

    const pending =
      await PendingRegistration.findOne({
        scholarId,
      });

    if (!pending) {
      return res.status(404).json({
        success: false,
        message:
          "Registration session expired. Please register again.",
      });
    }

    if (
      pending.otpExpiresAt.getTime() <
      Date.now()
    ) {
      await PendingRegistration.deleteOne({
        _id: pending._id,
      });

      return res.status(410).json({
        success: false,
        message:
          "OTP expired. Please request a new OTP.",
      });
    }

    if (
      pending.verifyAttempts >=
      MAX_OTP_VERIFY_ATTEMPTS
    ) {
      return res.status(429).json({
        success: false,
        message:
          "Too many incorrect attempts. Please register again.",
      });
    }

    const suppliedHash =
      hashValue(otp);

    if (
      suppliedHash !== pending.otpHash
    ) {
      pending.verifyAttempts += 1;
      await pending.save();

      return res.status(400).json({
        success: false,
        message: "Incorrect OTP.",
        attemptsRemaining:
          Math.max(
            0,
            MAX_OTP_VERIFY_ATTEMPTS -
              pending.verifyAttempts
          ),
      });
    }

    const existing =
      await Student.findOne({
        scholarId,
      });

    if (existing) {
      await PendingRegistration.deleteOne({
        _id: pending._id,
      });

      return res.status(409).json({
        success: false,
        message:
          "This Scholar ID is already registered.",
      });
    }

    const student =
      await Student.create({
        scholarId: pending.scholarId,
        collegeEmail:
          pending.collegeEmail,
        name: pending.name,
        room: pending.room,
        photo: pending.photo || "",
        passwordHash:
          pending.passwordHash,
        password: "",
        emailVerified: true,
        sessionTokenHash: "",
        sessionExpiresAt: null,
        lastClaimedMeal: "",
        lastClaimedAt: null,
      });

    await PendingRegistration.deleteOne({
      _id: pending._id,
    });

    res.json({
      success: true,
      message:
        "Registration successful. Your email has been verified.",
      student: studentResponse(student),
    });
  } catch (error) {
    console.error(
      "REGISTER VERIFY ERROR:",
      error
    );

    res.status(500).json({
      success: false,
      message:
        "Unable to verify registration.",
    });
  }
});

// ============================================================
// RESEND OTP
// ============================================================

app.post("/api/register/resend", async (req, res) => {
  try {
    await connectDB();

    const scholarId = cleanScholarId(
      req.body.scholarId
    );

    if (!scholarId) {
      return res.status(400).json({
        success: false,
        message: "Scholar ID is required.",
      });
    }

    const pending =
      await PendingRegistration.findOne({
        scholarId,
      });

    if (!pending) {
      return res.status(404).json({
        success: false,
        message:
          "Registration session not found.",
      });
    }

    const now = new Date();

    if (
      pending.lastOtpSentAt &&
      now.getTime() -
        pending.lastOtpSentAt.getTime() <
        OTP_RESEND_COOLDOWN_MS
    ) {
      const remaining = Math.ceil(
        (
          OTP_RESEND_COOLDOWN_MS -
          (
            now.getTime() -
            pending.lastOtpSentAt.getTime()
          )
        ) / 1000
      );

      return res.status(429).json({
        success: false,
        message:
          `Please wait ${remaining} seconds.`,
        cooldownSeconds: remaining,
      });
    }

    const windowAge =
      now.getTime() -
      pending.otpSendWindowStartedAt.getTime();

    if (windowAge >= 60 * 60 * 1000) {
      pending.otpSendCount = 0;
      pending.otpSendWindowStartedAt = now;
    }

    if (
      pending.otpSendCount >=
      MAX_OTP_SENDS_PER_HOUR
    ) {
      return res.status(429).json({
        success: false,
        message:
          "OTP request limit reached. Please try again later.",
      });
    }

    const otp = generateOtp();

    pending.otpHash = hashValue(otp);
    pending.otpExpiresAt = new Date(
      now.getTime() + OTP_EXPIRY_MS
    );
    pending.pendingExpiresAt = new Date(
      now.getTime() +
        PENDING_REGISTRATION_EXPIRY_MS
    );
    pending.lastOtpSentAt = now;
    pending.otpSendCount += 1;
    pending.verifyAttempts = 0;

    await pending.save();

    await sendOTPEmail(
      pending.collegeEmail,
      otp
    );

    res.json({
      success: true,
      message: "A new OTP has been sent.",
    });
  } catch (error) {
    console.error(
      "RESEND OTP ERROR:",
      error
    );

    res.status(500).json({
      success: false,
      message:
        "Unable to resend OTP.",
    });
  }
});

// ============================================================
// LOGIN
// ============================================================

app.post("/api/login", async (req, res) => {
  try {
    await connectDB();

    const scholarId = cleanScholarId(
      req.body.scholarId
    );

    const password = String(
      req.body.password || ""
    );

    if (!scholarId || !password) {
      return res.status(400).json({
        success: false,
        message:
          "Scholar ID and password are required.",
      });
    }

    const student =
      await Student.findOne({
        scholarId,
      });

    if (!student) {
      return res.status(401).json({
        success: false,
        message:
          "Invalid Scholar ID or password.",
      });
    }

    let passwordValid = false;

    if (student.passwordHash) {
      passwordValid =
        await bcrypt.compare(
          password,
          student.passwordHash
        );
    } else if (student.password) {
      passwordValid =
        password === student.password;

      if (passwordValid) {
        student.passwordHash =
          await bcrypt.hash(password, 12);
        student.password = "";
        await student.save();
      }
    }

    if (!passwordValid) {
      return res.status(401).json({
        success: false,
        message:
          "Invalid Scholar ID or password.",
      });
    }

    if (!student.emailVerified) {
      return res.status(403).json({
        success: false,
        message:
          "Please complete OTP verification first.",
      });
    }

    const sessionToken =
      generateSessionToken();

    student.sessionTokenHash =
      hashValue(sessionToken);

    student.sessionExpiresAt =
      new Date(
        Date.now() +
          SESSION_DURATION_MS
      );

    await student.save();

    res.json({
      success: true,
      message: "Login successful.",
      sessionToken,
      sessionExpiresAt:
        student.sessionExpiresAt,
      student:
        studentResponse(student),
    });
  } catch (error) {
    console.error(
      "LOGIN ERROR:",
      error
    );

    res.status(500).json({
      success: false,
      message:
        "Unable to login.",
    });
  }
});

// ============================================================
// STUDENT STATUS
// ============================================================

app.get("/api/status", async (req, res) => {
  try {
    await connectDB();

    const student =
      await authenticateStudent(req);

    if (!student) {
      return res.status(401).json({
        success: false,
        message:
          "Session expired. Please login again.",
      });
    }

    const now = new Date();

    const cooldown =
      cooldownInfo(
        student.lastClaimedAt,
        now
      );

    res.json({
      success: true,
      serverNow:
        now.toISOString(),

      student:
        studentResponse(student),

      claimed:
        cooldown.claimed,

      canClaim:
        cooldown.canClaim,

      cooldownRemainingMs:
        cooldown.cooldownRemainingMs,

      nextClaimAt:
        cooldown.nextClaimAt,
    });
  } catch (error) {
    console.error(
      "STATUS ERROR:",
      error
    );

    res.status(500).json({
      success: false,
      message:
        "Unable to fetch status.",
    });
  }
});

// ============================================================
// CLAIM MEAL
// ============================================================

app.post("/api/claim", async (req, res) => {
  try {
    await connectDB();

    const token =
      getBearerToken(req);

    if (!token) {
      return res.status(401).json({
        success: false,
        message:
          "Please login again.",
      });
    }

    const tokenHash =
      hashValue(token);

    const now = new Date();

    const cutoff =
      new Date(
        now.getTime() -
          MEAL_COOLDOWN_MS
      );

    /*
      IMPORTANT:

      The cooldown check is done inside the
      MongoDB update itself.

      This prevents two rapid requests from
      both successfully claiming a meal.
    */

    const student =
      await Student.findOneAndUpdate(
        {
          sessionTokenHash:
            tokenHash,

          sessionExpiresAt: {
            $gt: now,
          },

          emailVerified: true,

          $or: [
            {
              lastClaimedAt: null,
            },
            {
              lastClaimedAt: {
                $lte: cutoff,
              },
            },
          ],
        },
        {
          $set: {
            lastClaimedAt: now,
            lastClaimedMeal: "Meal",
          },
        },
        {
          new: true,
        }
      );

    if (!student) {
      const currentStudent =
        await Student.findOne({
          sessionTokenHash:
            tokenHash,
          sessionExpiresAt: {
            $gt: now,
          },
        });

      if (!currentStudent) {
        return res.status(401).json({
          success: false,
          message:
            "Session expired. Please login again.",
        });
      }

      const cooldown =
        cooldownInfo(
          currentStudent.lastClaimedAt,
          now
        );

      if (cooldown.claimed) {
        return res.status(429).json({
          success: false,
          message:
            "Meal already received.",
          claimed: true,
          cooldownRemainingMs:
            cooldown.cooldownRemainingMs,
          nextClaimAt:
            cooldown.nextClaimAt,
        });
      }

      return res.status(409).json({
        success: false,
        message:
          "Unable to claim the meal. Please try again.",
      });
    }

    const nextClaimAt =
      new Date(
        now.getTime() +
          MEAL_COOLDOWN_MS
      );

    res.json({
      success: true,
      message:
        "Meal received successfully.",
      claimed: true,
      claimedAt:
        now.toISOString(),
      nextClaimAt:
        nextClaimAt.toISOString(),
      cooldownRemainingMs:
        MEAL_COOLDOWN_MS,
    });
  } catch (error) {
    console.error(
      "CLAIM ERROR:",
      error
    );

    res.status(500).json({
      success: false,
      message:
        "Unable to record meal claim.",
    });
  }
});

// ============================================================
// LOGOUT
// ============================================================

app.post("/api/logout", async (req, res) => {
  try {
    await connectDB();

    const token =
      getBearerToken(req);

    if (token) {
      await Student.updateOne(
        {
          sessionTokenHash:
            hashValue(token),
        },
        {
          $set: {
            sessionTokenHash: "",
            sessionExpiresAt: null,
          },
        }
      );
    }

    res.json({
      success: true,
      message: "Logged out.",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Logout failed.",
    });
  }
});

// ============================================================
// STAFF LOGIN
// ============================================================

app.post("/api/staff/login", async (req, res) => {
  try {
    if (!STAFF_PIN) {
      return res.status(503).json({
        success: false,
        message:
          "Staff login is not configured on the server.",
      });
    }

    const pin = String(
      req.body.pin || ""
    );

    if (!pin) {
      return res.status(400).json({
        success: false,
        message:
          "Staff password is required.",
      });
    }

    if (pin !== STAFF_PIN) {
      return res.status(401).json({
        success: false,
        message:
          "Invalid staff password.",
      });
    }

    /*
      Stateless short-lived staff token.

      The token is derived from the private staff
      PIN and an expiry timestamp.
    */

    const expiresAt =
      Date.now() +
      4 * 60 * 60 * 1000;

    const payload =
      Buffer.from(
        `staff.${expiresAt}`
      ).toString("base64url");

    const signature =
      hashValue(
        `${payload}.${STAFF_PIN}`
      );

    const staffToken =
      `${payload}.${signature}`;

    res.json({
      success: true,
      message:
        "Staff login successful.",
      staffToken,
      expiresAt:
        new Date(expiresAt).toISOString(),
    });
  } catch (error) {
    console.error(
      "STAFF LOGIN ERROR:",
      error
    );

    res.status(500).json({
      success: false,
      message:
        "Staff login failed.",
    });
  }
});

// ============================================================
// STAFF TOKEN VERIFICATION
// ============================================================

function verifyStaffToken(token) {
  if (!STAFF_PIN || !token) {
    return false;
  }

  const parts =
    token.split(".");

  if (parts.length !== 2) {
    return false;
  }

  const payload = parts[0];
  const signature = parts[1];

  const expected =
    hashValue(
      `${payload}.${STAFF_PIN}`
    );

  if (signature !== expected) {
    return false;
  }

  try {
    const decoded =
      Buffer.from(
        payload,
        "base64url"
      ).toString("utf8");

    const [type, expiry] =
      decoded.split(".");

    if (type !== "staff") {
      return false;
    }

    if (
      Number(expiry) <= Date.now()
    ) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

function requireStaffToken(req, res, next) {
  const token =
    getBearerToken(req);

  if (!verifyStaffToken(token)) {
    return res.status(401).json({
      success: false,
      message:
        "Staff session expired.",
    });
  }

  next();
}

// ============================================================
// RESET ONE
// ============================================================

app.post(
  "/api/reset-one",
  requireStaffToken,
  async (req, res) => {
    try {
      await connectDB();

      const scholarId =
        cleanScholarId(
          req.body.scholarId
        );

      if (!scholarId) {
        return res.status(400).json({
          success: false,
          message:
            "Scholar ID is required.",
        });
      }

      const student =
        await Student.findOneAndUpdate(
          {
            scholarId,
          },
          {
            $set: {
              lastClaimedAt: null,
              lastClaimedMeal: "",
            },
          },
          {
            new: true,
          }
        );

      if (!student) {
        return res.status(404).json({
          success: false,
          message:
            "Student not found.",
        });
      }

      res.json({
        success: true,
        message:
          `Meal claim reset for ${student.scholarId}.`,
      });
    } catch (error) {
      console.error(
        "RESET ONE ERROR:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          "Unable to reset meal.",
      });
    }
  }
);

// ============================================================
// RESET ALL
// ============================================================

app.post(
  "/api/reset-all",
  requireStaffToken,
  async (req, res) => {
    try {
      await connectDB();

      const result =
        await Student.updateMany(
          {},
          {
            $set: {
              lastClaimedAt: null,
              lastClaimedMeal: "",
            },
          }
        );

      res.json({
        success: true,
        message:
          "All meal claims have been reset.",
        modified:
          result.modifiedCount,
      });
    } catch (error) {
      console.error(
        "RESET ALL ERROR:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          "Unable to reset all claims.",
      });
    }
  }
);

// ============================================================
// FRONTEND
// ============================================================

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);

app.get("/", (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      "public",
      "index.html"
    )
  );
});

// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, async () => {
  console.log(
    `MANIT Digital Mess Card running on port ${PORT}`
  );

  try {
    await connectDB();
    console.log("MongoDB connected.");
  } catch (error) {
    console.error(
      "MongoDB connection failed:",
      error.message
    );
  }
});
