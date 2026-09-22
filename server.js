const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const nodemailer = require("nodemailer");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;

// ============================================================
// BASIC CONFIG
// ============================================================

app.use(cors());

app.use(
  express.json({
    limit: "15mb",
  })
);

app.use(express.urlencoded({ extended: true, limit: "15mb" }));

// ============================================================
// EMAIL CONFIGURATION
// ============================================================

const EMAIL_ACCOUNTS = [
  {
    user: process.env.EMAIL_1,
    pass: process.env.PASS_1,
  },
  {
    user: process.env.EMAIL_2,
    pass: process.env.PASS_2,
  },
].filter((account) => account.user && account.pass);

console.log(
  `📧 Email account 1 configured: ${
    process.env.EMAIL_1 || "NOT CONFIGURED"
  }`
);

console.log(
  `📧 Email account 2 configured: ${
    process.env.EMAIL_2 || "NOT CONFIGURED"
  }`
);

const emailTransporters = EMAIL_ACCOUNTS.map((account) =>
  nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: account.user,
      pass: account.pass,
    },
  })
);

// ============================================================
// SEND OTP EMAIL
// ============================================================

async function sendOTPEmail(to, otp) {
  if (emailTransporters.length === 0) {
    throw new Error("No email accounts are configured.");
  }

  let lastError = null;

  for (let i = 0; i < emailTransporters.length; i++) {
    const transporter = emailTransporters[i];
    const account = EMAIL_ACCOUNTS[i];

    try {
      await transporter.sendMail({
        from: account.user,
        to: to,
        subject: "MANIT Mess Card - Email Verification OTP",

        text: `Your MANIT Mess Card verification OTP is ${otp}. This OTP is valid for 10 minutes. Do not share this OTP with anyone.`,

        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;">
            <h2 style="color:#222;">MANIT Digital Mess Card</h2>

            <p>Your email verification OTP is:</p>

            <div style="
              font-size:32px;
              font-weight:bold;
              letter-spacing:8px;
              padding:20px;
              background:#f4f4f4;
              text-align:center;
              border-radius:10px;
            ">
              ${otp}
            </div>

            <p>
              This OTP is valid for <b>10 minutes</b>.
            </p>

            <p>
              If you did not request this OTP, you can safely ignore this email.
            </p>

            <hr>

            <p style="font-size:12px;color:#777;">
              MANIT Digital Mess Card
            </p>
          </div>
        `,
      });

      console.log(`📨 OTP sent successfully to ${to}`);

      return true;
    } catch (error) {
      lastError = error;

      console.error(
        `❌ Email account ${i + 1} failed:`,
        error.message
      );
    }
  }

  throw new Error(
    `All email accounts failed. ${
      lastError ? lastError.message : ""
    }`
  );
}

// ============================================================
// MONGODB
// ============================================================

if (!MONGO_URI) {
  console.error("❌ MONGO_URI is not configured.");
  process.exit(1);
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

    // Kept only for compatibility with any old accounts.
    password: {
      type: String,
    },

    // Staff/physical mess-card verification
    isVerified: {
      type: Boolean,
      default: false,
    },

    // Email OTP verification
    emailVerified: {
      type: Boolean,
      default: false,
    },

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

    // Automatically delete pending registrations after 20 minutes.
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 20 * 60 * 1000),
      index: {
        expires: 0,
      },
    },
  },
  {
    timestamps: true,
  }
);

const Student = mongoose.model("Student", studentSchema);

const PendingRegistration = mongoose.model(
  "PendingRegistration",
  pendingRegistrationSchema
);

// ============================================================
// HELPER FUNCTIONS
// ============================================================

// IMPORTANT:
// There is NO 9-digit restriction here.
// Scholar numbers can contain letters, numbers, etc.

function cleanScholarId(value) {
  return String(value || "").trim().toLowerCase();
}

function generateOTP() {
  return crypto.randomInt(100000, 1000000).toString();
}

function hashOTP(otp) {
  return crypto
    .createHash("sha256")
    .update(String(otp))
    .digest("hex");
}

function maskEmail(email) {
  const [name, domain] = email.split("@");

  if (!name) {
    return email;
  }

  const visible = name.slice(0, 2);

  return `${visible}******@${domain}`;
}

// ============================================================
// HEALTH CHECK
// ============================================================

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    server: "online",
    mongodb: mongoose.connection.readyState,
    emailAccounts: EMAIL_ACCOUNTS.length,
  });
});

// ============================================================
// REGISTRATION - SEND OTP
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

    if (!scholarId || !name || !room || !password || !photo) {
      return res.status(400).json({
        success: false,
        message: "Please fill all registration fields.",
      });
    }

    if (String(password).length < 6) {
      return res.status(400).json({
        success: false,
        message: "Password must contain at least 6 characters.",
      });
    }

    // ========================================================
    // NO 9-DIGIT RESTRICTION
    // ========================================================

    const cleanId = cleanScholarId(scholarId);

    if (!cleanId) {
      return res.status(400).json({
        success: false,
        message: "Please enter your scholar number.",
      });
    }

    const collegeEmail =
      `${cleanId}@stu.manit.ac.in`;

    // ========================================================
    // CHECK IF ACCOUNT ALREADY EXISTS
    // ========================================================

    const existingStudent = await Student.findOne({
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

    let pending = await PendingRegistration.findOne({
      scholarId: cleanId,
    });

    // ========================================================
    // RESEND COOLDOWN
    // ========================================================

    if (
      pending &&
      pending.lastSentAt &&
      now.getTime() - pending.lastSentAt.getTime() < 60 * 1000
    ) {
      return res.status(429).json({
        success: false,
        message:
          "Please wait 60 seconds before requesting another OTP.",
      });
    }

    // ========================================================
    // MAX 5 OTPs PER HOUR
    // ========================================================

    let sendWindowStartedAt =
      pending?.sendWindowStartedAt || null;

    let sendCount = pending?.sendCount || 0;

    if (
      !sendWindowStartedAt ||
      now.getTime() - sendWindowStartedAt.getTime() >=
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

    // ========================================================
    // GENERATE OTP
    // ========================================================

    const otp = generateOTP();

    const otpHash = hashOTP(otp);

    const passwordHash = await bcrypt.hash(password, 12);

    if (!pending) {
      pending = new PendingRegistration({
        scholarId: cleanId,
        collegeEmail,
        name: String(name).trim(),
        room: String(room).trim(),
        passwordHash,
        photo,
        otpHash,
        otpExpiresAt: new Date(
          now.getTime() + 10 * 60 * 1000
        ),
        attempts: 0,
        lastSentAt: now,
        sendWindowStartedAt,
        sendCount: sendCount + 1,
        expiresAt: new Date(
          now.getTime() + 20 * 60 * 1000
        ),
      });
    } else {
      pending.collegeEmail = collegeEmail;
      pending.name = String(name).trim();
      pending.room = String(room).trim();
      pending.passwordHash = passwordHash;
      pending.photo = photo;
      pending.otpHash = otpHash;
      pending.otpExpiresAt = new Date(
        now.getTime() + 10 * 60 * 1000
      );
      pending.attempts = 0;
      pending.lastSentAt = now;
      pending.sendWindowStartedAt = sendWindowStartedAt;
      pending.sendCount = sendCount + 1;
      pending.expiresAt = new Date(
        now.getTime() + 20 * 60 * 1000
      );
    }

    await pending.save();

    // ========================================================
    // SEND EMAIL
    // ========================================================

    try {
      await sendOTPEmail(collegeEmail, otp);
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
      message: "OTP sent successfully.",
      email: maskEmail(collegeEmail),
    });
  } catch (error) {
    console.error(
      "❌ /register/start error:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Server error while starting registration.",
    });
  }
}

app.post(
  "/api/register/start",
  registerStart
);

// Compatibility endpoint
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
      otp,
    } = req.body;

    const cleanId = cleanScholarId(scholarId);

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

    // ========================================================
    // OTP EXPIRY
    // ========================================================

    if (
      !pending.otpExpiresAt ||
      new Date() > pending.otpExpiresAt
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

    // ========================================================
    // MAX ATTEMPTS
    // ========================================================

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

    const suppliedHash = hashOTP(
      String(otp).trim()
    );

    if (suppliedHash !== pending.otpHash) {
      pending.attempts += 1;

      await pending.save();

      return res.status(400).json({
        success: false,
        message: "Incorrect OTP.",
      });
    }

    // ========================================================
    // CREATE STUDENT ACCOUNT
    // ========================================================

    try {
      const student = new Student({
        scholarId: pending.scholarId,
        collegeEmail: pending.collegeEmail,
        name: pending.name,
        room: pending.room,
        passwordHash: pending.passwordHash,
        photo: pending.photo,

        // Email has now been verified.
        emailVerified: true,

        // Staff still needs to activate the mess card.
        isVerified: false,

        lastClaimedMeal: "",
        lastClaimedAt: null,
      });

      await student.save();
    } catch (createError) {
      if (createError.code === 11000) {
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
        "Registration successful! You can now login.",
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

// Compatibility endpoint
app.post(
  "/api/verify-otp",
  registerVerify
);

// ============================================================
// REGISTRATION - RESEND OTP
// ============================================================

async function registerResend(req, res) {
  try {
    const {
      scholarId,
    } = req.body;

    const cleanId = cleanScholarId(scholarId);

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

    // ========================================================
    // 60 SECOND COOLDOWN
    // ========================================================

    if (
      pending.lastSentAt &&
      now.getTime() - pending.lastSentAt.getTime() <
        60 * 1000
    ) {
      const remaining = Math.ceil(
        (60 * 1000 -
          (now.getTime() -
            pending.lastSentAt.getTime())) /
          1000
      );

      return res.status(429).json({
        success: false,
        message:
          `Please wait ${remaining} seconds before requesting another OTP.`,
      });
    }

    // ========================================================
    // 5 PER HOUR
    // ========================================================

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

    // ========================================================
    // GENERATE NEW OTP
    // ========================================================

    const otp = generateOTP();

    try {
      await sendOTPEmail(
        pending.collegeEmail,
        otp
      );
    } catch (emailError) {
      console.error(
        "❌ Resend OTP failed:",
        emailError.message
      );

      return res.status(500).json({
        success: false,
        message:
          "Could not send OTP email. Please try again later.",
      });
    }

    pending.otpHash = hashOTP(otp);

    pending.otpExpiresAt = new Date(
      now.getTime() + 10 * 60 * 1000
    );

    pending.attempts = 0;
    pending.lastSentAt = now;
    pending.sendWindowStartedAt =
      sendWindowStartedAt;

    pending.sendCount = sendCount + 1;

    pending.expiresAt = new Date(
      now.getTime() + 20 * 60 * 1000
    );

    await pending.save();

    return res.json({
      success: true,
      message: "New OTP sent successfully.",
      email: maskEmail(
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

app.post("/api/login", async (req, res) => {
  try {
    const {
      scholarId,
      password,
    } = req.body;

    const cleanId = cleanScholarId(scholarId);

    if (!cleanId || !password) {
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

    let passwordCorrect = false;

    // New accounts
    if (student.passwordHash) {
      passwordCorrect =
        await bcrypt.compare(
          password,
          student.passwordHash
        );
    }

    // Old accounts created before password hashing
    else if (student.password) {
      passwordCorrect =
        student.password === password;

      // Automatically migrate old password
      if (passwordCorrect) {
        student.passwordHash =
          await bcrypt.hash(password, 12);

        student.password = undefined;

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

    return res.json({
      success: true,
      student: {
        scholarId: student.scholarId,
        collegeEmail: student.collegeEmail,
        name: student.name,
        room: student.room,
        photo: student.photo,
        isVerified: student.isVerified,
        emailVerified:
          student.emailVerified,
        lastClaimedMeal:
          student.lastClaimedMeal || "",
        lastClaimedAt:
          student.lastClaimedAt || null,
      },
    });
  } catch (error) {
    console.error(
      "❌ /api/login error:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Server error during login.",
    });
  }
});

// ============================================================
// GET STUDENT STATUS
// ============================================================

app.get(
  "/api/status/:scholarId",
  async (req, res) => {
    try {
      const cleanId = cleanScholarId(
        req.params.scholarId
      );

      if (!cleanId) {
        return res.status(400).json({
          success: false,
          message:
            "Scholar number is required.",
        });
      }

      const student =
        await Student.findOne({
          scholarId: cleanId,
        }).lean();

      if (!student) {
        return res.status(404).json({
          success: false,
          message: "Student not found.",
        });
      }

      return res.json({
        success: true,
        student: {
          scholarId: student.scholarId,
          collegeEmail:
            student.collegeEmail,
          name: student.name,
          room: student.room,
          photo: student.photo,
          isVerified:
            student.isVerified,
          emailVerified:
            student.emailVerified,
          lastClaimedMeal:
            student.lastClaimedMeal || "",
          lastClaimedAt:
            student.lastClaimedAt || null,
        },
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
// SCAN / MEAL CLAIM
// ============================================================

app.post("/api/scan", async (req, res) => {
  try {
    const {
      scholarId,
      meal,
      staffPin,
    } = req.body;

    // Demo staff PIN.
    // Move this to an environment variable
    // before production use.
    const STAFF_PIN = "manitH10";

    if (staffPin !== STAFF_PIN) {
      return res.status(401).json({
        success: false,
        message: "Invalid staff PIN.",
      });
    }

    const cleanId = cleanScholarId(
      scholarId
    );

    if (!cleanId) {
      return res.status(400).json({
        success: false,
        message:
          "Scholar number is required.",
      });
    }

    if (!meal) {
      return res.status(400).json({
        success: false,
        message: "Meal is required.",
      });
    }

    const student =
      await Student.findOne({
        scholarId: cleanId,
      });

    if (!student) {
      return res.status(404).json({
        success: false,
        message: "Student not found.",
      });
    }

    if (!student.isVerified) {
      return res.status(403).json({
        success: false,
        message:
          "Student has not been activated by mess staff yet.",
      });
    }

    const today = new Date();

    const todayString =
      today.toISOString().split("T")[0];

    if (
      student.lastClaimedMeal === meal &&
      student.lastClaimedAt
    ) {
      const previousDate =
        new Date(student.lastClaimedAt)
          .toISOString()
          .split("T")[0];

      if (previousDate === todayString) {
        return res.status(409).json({
          success: false,
          message:
            `Student has already claimed ${meal} today.`,
        });
      }
    }

    student.lastClaimedMeal = meal;
    student.lastClaimedAt = new Date();

    await student.save();

    return res.json({
      success: true,
      message:
        `${meal} marked successfully for ${student.name}.`,
      student: {
        scholarId:
          student.scholarId,
        name: student.name,
        room: student.room,
      },
    });
  } catch (error) {
    console.error(
      "❌ /api/scan error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Server error while scanning.",
    });
  }
});

// ============================================================
// RESET ONE STUDENT
// ============================================================

app.post(
  "/api/reset-one",
  async (req, res) => {
    try {
      const {
        scholarId,
        staffPin,
      } = req.body;

      const STAFF_PIN = "manitH10";

      if (staffPin !== STAFF_PIN) {
        return res.status(401).json({
          success: false,
          message: "Invalid staff PIN.",
        });
      }

      const cleanId =
        cleanScholarId(scholarId);

      const student =
        await Student.findOne({
          scholarId: cleanId,
        });

      if (!student) {
        return res.status(404).json({
          success: false,
          message:
            "Student not found.",
        });
      }

      student.lastClaimedMeal = "";
      student.lastClaimedAt = null;

      await student.save();

      return res.json({
        success: true,
        message:
          "Student meal status reset successfully.",
      });
    } catch (error) {
      console.error(
        "❌ /api/reset-one error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Server error while resetting student.",
      });
    }
  }
);

// ============================================================
// RESET ALL STUDENTS
// ============================================================

app.post(
  "/api/reset-all",
  async (req, res) => {
    try {
      const {
        staffPin,
      } = req.body;

      const STAFF_PIN = "manitH10";

      if (staffPin !== STAFF_PIN) {
        return res.status(401).json({
          success: false,
          message: "Invalid staff PIN.",
        });
      }

      await Student.updateMany(
        {},
        {
          $set: {
            lastClaimedMeal: "",
            lastClaimedAt: null,
          },
        }
      );

      return res.json({
        success: true,
        message:
          "All student meal statuses have been reset.",
      });
    } catch (error) {
      console.error(
        "❌ /api/reset-all error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Server error while resetting all students.",
      });
    }
  }
);

// ============================================================
// SERVE FRONTEND
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
// 404 API HANDLER
// ============================================================

app.use("/api", (req, res) => {
  res.status(404).json({
    success: false,
    message:
      `API endpoint not found: ${req.method} ${req.originalUrl}`,
  });
});

// ============================================================
// ERROR HANDLER
// ============================================================

app.use((error, req, res, next) => {
  console.error("❌ Server error:", error);

  res.status(500).json({
    success: false,
    message: "Internal server error.",
  });
});

// ============================================================
// START SERVER AFTER MONGODB CONNECTS
// ============================================================

async function startServer() {
  try {
    await mongoose.connect(MONGO_URI);

    console.log(
      "✅ MongoDB Atlas Connected Successfully"
    );

    app.listen(PORT, () => {
      console.log(
        `🚀 Production server live on port ${PORT}`
      );
    });
  } catch (error) {
    console.error(
      "❌ MongoDB connection failed:",
      error.message
    );

    process.exit(1);
  }
}

startServer();
