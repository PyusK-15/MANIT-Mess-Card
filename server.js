const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const path = require("path");

const app = express();

const MONGO_URI = process.env.MONGO_URI;

const PORT = process.env.PORT || 10000;

app.use(cors());

app.use(
  express.json({
    limit: "15mb",
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "15mb",
  })
);

// ============================================================
// DATABASE CONNECTION
// ============================================================

let cached = global.mongoose;

if (!cached) {
  cached = global.mongoose = {
    conn: null,
    promise: null,
  };
}

async function connectDB() {
  if (cached.conn) {
    return cached.conn;
  }

  if (!cached.promise) {
    mongoose.set("bufferCommands", false);

    cached.promise = mongoose
      .connect(MONGO_URI, {
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 30000,
      })
      .then((mongooseInstance) => {
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

app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (error) {
    console.error("❌ Database connection error:", error);

    res.status(500).json({
      success: false,
      message: "Database connection failed.",
    });
  }
});

// ============================================================
// BREVO
// ============================================================

const BREVO_API_KEY = process.env.BREVO_API_KEY
  ? process.env.BREVO_API_KEY.trim()
  : "";

const BREVO_SENDERS = [
  process.env.BREVO_SENDER_EMAIL_1,
  process.env.BREVO_SENDER_EMAIL_2,
]
  .map((email) => (email ? email.trim().toLowerCase() : ""))
  .filter(Boolean)
  .filter(
    (email, index, array) =>
      array.indexOf(email) === index
  );

console.log(
  `📧 Brevo configured: ${BREVO_API_KEY ? "YES" : "NO"}`
);

console.log(
  `📧 Brevo senders: ${BREVO_SENDERS.length}`
);

// ============================================================
// BREVO EMAIL
// ============================================================

async function sendBrevoEmail(senderEmail, to, otp) {
  if (!BREVO_API_KEY) {
    throw new Error(
      "BREVO_API_KEY is not configured."
    );
  }

  const emailData = {
    sender: {
      name: "MANIT Digital Mess Card",
      email: senderEmail,
    },

    to: [
      {
        email: to,
      },
    ],

    subject:
      "MANIT Digital Mess Card - Email Verification OTP",

    textContent:
      `Your MANIT Digital Mess Card verification OTP is ${otp}. ` +
      `This OTP is valid for 10 minutes. ` +
      `Do not share this OTP with anyone.`,

    htmlContent: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>MANIT Digital Mess Card</title>
      </head>

      <body
        style="
          margin:0;
          padding:0;
          background:#eef2ff;
          font-family:Arial,sans-serif;
        "
      >

        <div
          style="
            max-width:600px;
            margin:35px auto;
            background:#ffffff;
            padding:35px;
            border-radius:20px;
            box-shadow:0 10px 40px rgba(0,0,0,.08);
          "
        >

          <h2
            style="
              color:#0f172a;
              margin-top:0;
            "
          >
            MANIT Digital Mess Card
          </h2>

          <p>
            Your email verification OTP is:
          </p>

          <div
            style="
              font-size:34px;
              font-weight:bold;
              letter-spacing:9px;
              padding:22px;
              background:#eef2ff;
              text-align:center;
              border-radius:14px;
              margin:24px 0;
              color:#2563eb;
            "
          >
            ${otp}
          </div>

          <p>
            This OTP is valid for
            <b>10 minutes</b>.
          </p>

          <p>
            Please do not share this OTP with anyone.
          </p>

          <p>
            If you did not request this OTP,
            you can safely ignore this email.
          </p>

          <hr
            style="
              border:none;
              border-top:1px solid #e5e7eb;
              margin:28px 0;
            "
          >

          <p
            style="
              font-size:12px;
              color:#64748b;
            "
          >
            MANIT Digital Mess Card
          </p>

        </div>

      </body>
      </html>
    `,
  };

  const response = await fetch(
    "https://api.brevo.com/v3/smtp/email",
    {
      method: "POST",

      headers: {
        accept: "application/json",
        "api-key": BREVO_API_KEY,
        "content-type": "application/json",
      },

      body: JSON.stringify(emailData),
    }
  );

  const responseText = await response.text();

  let responseData = null;

  try {
    responseData = responseText
      ? JSON.parse(responseText)
      : null;
  } catch {
    responseData = null;
  }

  if (!response.ok) {
    const errorMessage =
      responseData?.message ||
      responseText ||
      `Brevo returned HTTP ${response.status}`;

    const error = new Error(errorMessage);

    error.status = response.status;
    error.response = responseData;

    throw error;
  }

  return responseData;
}

async function sendOTPEmail(to, otp) {
  if (!BREVO_API_KEY) {
    throw new Error(
      "Brevo API key is not configured."
    );
  }

  if (BREVO_SENDERS.length === 0) {
    throw new Error(
      "No Brevo sender emails are configured."
    );
  }

  let lastError = null;

  for (let i = 0; i < BREVO_SENDERS.length; i++) {
    try {
      console.log(
        `📤 Trying Brevo sender ${i + 1}: ${BREVO_SENDERS[i]}`
      );

      const result = await sendBrevoEmail(
        BREVO_SENDERS[i],
        to,
        otp
      );

      console.log(
        `📨 OTP sent successfully to ${to}`
      );

      if (result?.messageId) {
        console.log(
          `📨 Brevo message ID: ${result.messageId}`
        );
      }

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
    `All Brevo sender accounts failed. ${
      lastError ? lastError.message : ""
    }`
  );
}

// ============================================================
// STUDENT SCHEMA
// ============================================================

const studentSchema = new mongoose.Schema(
  {
    scholarId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
    },

    collegeEmail: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
      lowercase: true,
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
      required: true,
    },

    passwordHash: {
      type: String,
    },

    // Legacy field retained so existing accounts
    // do not break during migration.
    password: {
      type: String,
    },

    // Email/OTP verification.
    emailVerified: {
      type: Boolean,
      default: false,
    },

    // Kept for compatibility with old database records.
    // It is no longer required for meal claims.
    isVerified: {
      type: Boolean,
      default: true,
    },

    lastClaimedMeal: {
      type: String,
      default: "",
    },

    lastClaimedAt: {
      type: Date,
      default: null,
    },

    // Server-side session token.
    sessionTokenHash: {
      type: String,
      default: "",
    },

    sessionExpiresAt: {
      type: Date,
      default: null,
    },
  },

  {
    timestamps: true,
  }
);

// ============================================================
// PENDING REGISTRATION
// ============================================================

const pendingRegistrationSchema =
  new mongoose.Schema(
    {
      scholarId: {
        type: String,
        required: true,
        unique: true,
        index: true,
        trim: true,
      },

      collegeEmail: {
        type: String,
        required: true,
        trim: true,
        lowercase: true,
      },

      name: {
        type: String,
        required: true,
      },

      room: {
        type: String,
        required: true,
      },

      passwordHash: {
        type: String,
        required: true,
      },

      photo: {
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

      attempts: {
        type: Number,
        default: 0,
      },

      lastSentAt: {
        type: Date,
        default: null,
      },

      sendWindowStartedAt: {
        type: Date,
        default: null,
      },

      sendCount: {
        type: Number,
        default: 0,
      },

      expiresAt: {
        type: Date,

        default: () =>
          new Date(
            Date.now() +
              20 * 60 * 1000
          ),

        index: {
          expires: 0,
        },
      },
    },

    {
      timestamps: true,
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
    .randomBytes(32)
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

  const name = parts[0];
  const domain = parts[1];

  if (!name || !domain) {
    return email;
  }

  return `${name.slice(0, 2)}******@${domain}`;
}

function publicStudent(student, sessionToken = null) {
  return {
    scholarId: student.scholarId,
    collegeEmail: student.collegeEmail,
    name: student.name,
    room: student.room,
    photo: student.photo,

    // OTP verification is the actual verification.
    isVerified: Boolean(student.emailVerified),

    emailVerified: Boolean(student.emailVerified),

    lastClaimedMeal:
      student.lastClaimedMeal || "",

    lastClaimedAt:
      student.lastClaimedAt || null,

    sessionToken,
  };
}

// ============================================================
// AUTHENTICATION
// ============================================================

async function authenticateStudent(req, res) {
  const auth =
    req.headers.authorization || "";

  if (!auth.startsWith("Bearer ")) {
    res.status(401).json({
      success: false,
      message:
        "Your login session is missing. Please login again.",
    });

    return null;
  }

  const token = auth.slice(7).trim();

  if (!token) {
    res.status(401).json({
      success: false,
      message:
        "Invalid login session.",
    });

    return null;
  }

  const tokenHash =
    hashSessionToken(token);

  const student =
    await Student.findOne({
      sessionTokenHash: tokenHash,
    });

  if (!student) {
    res.status(401).json({
      success: false,
      message:
        "Login session expired. Please login again.",
    });

    return null;
  }

  if (
    !student.sessionExpiresAt ||
    student.sessionExpiresAt.getTime() <
      Date.now()
  ) {
    student.sessionTokenHash = "";
    student.sessionExpiresAt = null;

    await student.save();

    res.status(401).json({
      success: false,
      message:
        "Login session expired. Please login again.",
    });

    return null;
  }

  return student;
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
    emailService: "Brevo",
    emailSenders:
      BREVO_SENDERS.length,
  });
});

// ============================================================
// REGISTER START
// ============================================================

async function registerStart(req, res) {
  try {
    const {
      scholarId,
      name,
      room,
      password,
      photo,
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
          "Please fill all registration fields.",
      });
    }

    if (String(password).length < 6) {
      return res.status(400).json({
        success: false,
        message:
          "Password must contain at least 6 characters.",
      });
    }

    // No 9-digit restriction.

    const cleanId =
      cleanScholarId(scholarId);

    if (!cleanId) {
      return res.status(400).json({
        success: false,
        message:
          "Please enter your scholar number.",
      });
    }

    const collegeEmail =
      `${cleanId}@stu.manit.ac.in`;

    const existingStudent =
      await Student.findOne({
        scholarId: cleanId,
      });

    if (existingStudent) {
      return res.status(409).json({
        success: false,
        message:
          "An account with this scholar number already exists. Please login.",
      });
    }

    const now = new Date();

    let pending =
      await PendingRegistration.findOne({
        scholarId: cleanId,
      });

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
          "Please wait 60 seconds before requesting another OTP.",
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
          "Too many OTP requests. Please try again after one hour.",
      });
    }

    const otp = generateOTP();

    const otpHash = hashOTP(otp);

    const passwordHash =
      await bcrypt.hash(
        password,
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
            ),
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

      pending.photo = photo;

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

      await PendingRegistration.deleteOne({
        scholarId: cleanId,
      });

      return res.status(500).json({
        success: false,
        message:
          "Could not send OTP email. Please try again later.",
      });
    }

    return res.json({
      success: true,

      message:
        "OTP sent successfully.",

      email:
        maskEmail(
          collegeEmail
        ),
    });
  } catch (error) {
    console.error(
      "❌ /register/start error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Server error while starting registration.",
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
// VERIFY OTP
// ============================================================

async function registerVerify(req, res) {
  try {
    const {
      scholarId,
      otp,
    } = req.body;

    const cleanId =
      cleanScholarId(scholarId);

    if (!cleanId || !otp) {
      return res.status(400).json({
        success: false,
        message:
          "Scholar number and OTP are required.",
      });
    }

    const pending =
      await PendingRegistration.findOne({
        scholarId: cleanId,
      });

    if (!pending) {
      return res.status(404).json({
        success: false,
        message:
          "Registration session expired. Please start registration again.",
      });
    }

    if (
      !pending.otpExpiresAt ||
      new Date() >
        pending.otpExpiresAt
    ) {
      await PendingRegistration.deleteOne({
        scholarId: cleanId,
      });

      return res.status(400).json({
        success: false,
        message:
          "OTP has expired. Please request a new OTP.",
      });
    }

    if (pending.attempts >= 5) {
      await PendingRegistration.deleteOne({
        scholarId: cleanId,
      });

      return res.status(429).json({
        success: false,
        message:
          "Too many incorrect OTP attempts. Please start again.",
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
          "Incorrect OTP.",
      });
    }

    let student;

    try {
      student =
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

          // OTP verification activates the card.
          isVerified:
            true,

          lastClaimedMeal:
            "",

          lastClaimedAt:
            null,
        });

      await student.save();
    } catch (createError) {
      if (
        createError.code ===
        11000
      ) {
        return res.status(409).json({
          success: false,
          message:
            "An account with this scholar number or email already exists.",
        });
      }

      throw createError;
    }

    await PendingRegistration.deleteOne({
      scholarId: cleanId,
    });

    return res.json({
      success: true,

      message:
        "Registration successful! Your email has been verified. You can now login.",

      student: {
        scholarId: cleanId,
      },
    });
  } catch (error) {
    console.error(
      "❌ /register/verify error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Server error while verifying OTP.",
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
      scholarId,
    } = req.body;

    const cleanId =
      cleanScholarId(scholarId);

    if (!cleanId) {
      return res.status(400).json({
        success: false,
        message:
          "Please enter your scholar number.",
      });
    }

    const pending =
      await PendingRegistration.findOne({
        scholarId: cleanId,
      });

    if (!pending) {
      return res.status(404).json({
        success: false,
        message:
          "Registration session expired. Please register again.",
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
          `Please wait ${remaining} seconds before requesting another OTP.`,
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
          "Too many OTP requests. Please try again after one hour.",
      });
    }

    const otp = generateOTP();

    try {
      await sendOTPEmail(
        pending.collegeEmail,
        otp
      );
    } catch (emailError) {
      console.error(
        "❌ Resend OTP email failed:",
        emailError.message
      );

      return res.status(500).json({
        success: false,
        message:
          "Could not send OTP email. Please try again later.",
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
        ),
    });
  } catch (error) {
    console.error(
      "❌ /register/resend error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Server error while resending OTP.",
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
        password,
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
            "Scholar number and password are required.",
        });
      }

      const student =
        await Student.findOne({
          scholarId: cleanId,
        });

      if (!student) {
        return res.status(401).json({
          success: false,
          message:
            "Invalid scholar number or password.",
        });
      }

      let passwordCorrect =
        false;

      if (student.passwordHash) {
        passwordCorrect =
          await bcrypt.compare(
            password,
            student.passwordHash
          );
      } else if (student.password) {
        passwordCorrect =
          student.password ===
          password;

        if (passwordCorrect) {
          student.passwordHash =
            await bcrypt.hash(
              password,
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
            "Invalid scholar number or password.",
        });
      }

      // If an old account exists that was created before
      // OTP verification became the activation mechanism,
      // require email verification.
      if (!student.emailVerified) {
        return res.status(403).json({
          success: false,
          message:
            "This account has not completed email verification.",
        });
      }

      const sessionToken =
        generateSessionToken();

      student.sessionTokenHash =
        hashSessionToken(
          sessionToken
        );

      // Login remains valid for 12 hours.
      student.sessionExpiresAt =
        new Date(
          Date.now() +
            12 * 60 * 60 * 1000
        );

      await student.save();

      return res.json({
        success: true,

        student:
          publicStudent(
            student,
            sessionToken
          ),
      });
    } catch (error) {
      console.error(
        "❌ /api/login error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Server error while logging in.",
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
          req,
          res
        );

      if (!student) {
        return;
      }

      student.sessionTokenHash = "";
      student.sessionExpiresAt = null;

      await student.save();

      return res.json({
        success: true,
        message: "Logged out.",
      });
    } catch (error) {
      console.error(
        "❌ /api/logout error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Could not logout.",
      });
    }
  }
);

// ============================================================
// STATUS
// ============================================================

app.get(
  "/api/status",
  async (req, res) => {
    try {
      const student =
        await authenticateStudent(
          req,
          res
        );

      if (!student) {
        return;
      }

      const lastClaimedAt =
        student.lastClaimedAt
          ? student.lastClaimedAt.getTime()
          : null;

      const cooldownMs =
        2 * 60 * 60 * 1000;

      let cooldownEndsAt = null;

      let claimAvailable = true;

      if (lastClaimedAt) {
        cooldownEndsAt =
          lastClaimedAt +
          cooldownMs;

        if (
          Date.now() <
          cooldownEndsAt
        ) {
          claimAvailable = false;
        }
      }

      return res.json({
        success: true,

        student: publicStudent(
          student
        ),

        claimed:
          Boolean(
            student.lastClaimedMeal
          ),

        lastClaimedMeal:
          student.lastClaimedMeal ||
          "",

        lastClaimedAt:
          student.lastClaimedAt ||
          null,

        claimAvailable,

        cooldownEndsAt,

        cooldownRemainingMs:
          claimAvailable
            ? 0
            : Math.max(
                0,
                cooldownEndsAt -
                  Date.now()
              ),
      });
    } catch (error) {
      console.error(
        "❌ /api/status error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Server error while checking status.",
      });
    }
  }
);

// ============================================================
// CLAIM MEAL
// ============================================================
//
// IMPORTANT:
// There are intentionally NO meal-time restrictions.
//
// The student can claim whenever the card is available.
// The only restriction is:
//     one successful claim every 2 hours.
//
// ============================================================

app.post(
  "/api/claim",
  async (req, res) => {
    try {
      const student =
        await authenticateStudent(
          req,
          res
        );

      if (!student) {
        return;
      }

      if (!student.emailVerified) {
        return res.status(403).json({
          success: false,
          status: "denied",
          message:
            "Email verification is required.",
        });
      }

      const now = new Date();

      const cooldownMs =
        2 * 60 * 60 * 1000;

      if (
        student.lastClaimedAt &&
        now.getTime() -
          student.lastClaimedAt.getTime() <
          cooldownMs
      ) {
        const availableAt =
          new Date(
            student.lastClaimedAt.getTime() +
              cooldownMs
          );

        const remaining =
          Math.max(
            0,
            availableAt.getTime() -
              now.getTime()
          );

        return res.status(429).json({
          success: false,
          status: "cooldown",

          message:
            "Meal already received. Please wait until the 2-hour cooldown ends.",

          lastClaimedMeal:
            student.lastClaimedMeal ||
            "Meal",

          lastClaimedAt:
            student.lastClaimedAt,

          cooldownEndsAt:
            availableAt,

          cooldownRemainingMs:
            remaining,
        });
      }

      /*
       * We don't impose breakfast/lunch/dinner
       * restrictions.
       *
       * Instead we record the claim as a live
       * mess claim.
       */

      const claimLabel =
        "Mess Meal";

      /*
       * Atomic update.
       *
       * This prevents two almost-simultaneous
       * requests from both successfully claiming
       * the meal.
       */

      const previousCutoff =
        new Date(
          now.getTime() -
            cooldownMs
        );

      const updatedStudent =
        await Student.findOneAndUpdate(
          {
            _id: student._id,

            emailVerified: true,

            $or: [
              {
                lastClaimedAt:
                  null,
              },

              {
                lastClaimedAt: {
                  $lte:
                    previousCutoff,
                },
              },
            ],
          },

          {
            $set: {
              lastClaimedMeal:
                claimLabel,

              lastClaimedAt:
                now,
            },
          },

          {
            new: true,
          }
        );

      if (!updatedStudent) {
        const latest =
          await Student.findById(
            student._id
          );

        const availableAt =
          latest?.lastClaimedAt
            ? new Date(
                latest.lastClaimedAt.getTime() +
                  cooldownMs
              )
            : now;

        return res.status(429).json({
          success: false,
          status: "cooldown",

          message:
            "Meal already received. Please wait until the 2-hour cooldown ends.",

          lastClaimedMeal:
            latest?.lastClaimedMeal ||
            "Meal",

          lastClaimedAt:
            latest?.lastClaimedAt ||
            null,

          cooldownEndsAt:
            availableAt,

          cooldownRemainingMs:
            Math.max(
              0,
              availableAt.getTime() -
                Date.now()
            ),
        });
      }

      console.log(
        `🍽️ MEAL CLAIMED: ${updatedStudent.scholarId} at ${now.toISOString()}`
      );

      return res.json({
        success: true,

        status: "claimed",

        message:
          "Meal received successfully.",

        meal:
          claimLabel,

        claimedAt:
          updatedStudent.lastClaimedAt,

        cooldownEndsAt:
          new Date(
            now.getTime() +
              cooldownMs
          ),

        cooldownDurationMs:
          cooldownMs,
      });
    } catch (error) {
      console.error(
        "❌ /api/claim error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Server error while claiming meal.",
      });
    }
  }
);

// ============================================================
// LEGACY ROUTES
// ============================================================
//
// These intentionally do NOT provide QR scanning anymore.
// They return a clear message so an old cached frontend
// cannot silently perform the previous staff-scan workflow.
//

app.post(
  "/api/scan",
  (req, res) => {
    return res.status(410).json({
      success: false,
      message:
        "QR scanning has been removed. Students now claim meals directly from their digital card.",
    });
  }
);

app.post(
  "/api/reset-one",
  (req, res) => {
    return res.status(410).json({
      success: false,
      message:
        "The old staff reset system has been removed.",
    });
  }
);

app.post(
  "/api/reset-all",
  (req, res) => {
    return res.status(410).json({
      success: false,
      message:
        "The old staff reset system has been removed.",
    });
  }
);

// ============================================================
// STATIC WEBSITE
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
  "*",
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
// START SERVER
// ============================================================

app.listen(
  PORT,
  () => {
    console.log(
      `🚀 MANIT Digital Mess Card running on port ${PORT}`
    );
  }
);
