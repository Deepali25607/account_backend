require("dotenv").config();

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

require("./src/db"); // initialise schema on boot

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
// Company backup imports can be large (full dataset + logo data-URL); give that
// one path a roomier body limit before the global parser claims the request.
app.use("/api/backup", express.json({ limit: "50mb" }));
app.use(express.json({ limit: "6mb" })); // headroom for QR image data-URLs

app.get("/health", (req, res) => res.json({ status: "ok" }));

// Throttle auth endpoints to blunt brute-force / credential-stuffing (§7.3).
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,                       // 20 login/register attempts per IP per 15 min
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please try again later." },
});
// General API ceiling as a backstop against abuse.
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false });
app.use("/api", apiLimiter);

app.use("/api/auth/login", authLimiter);
app.use("/api/auth/register", authLimiter);
app.use("/api/auth", require("./src/routes/auth"));
app.use("/api", require("./src/routes/masters"));
app.use("/api", require("./src/routes/transactions"));
app.use("/api/reports", require("./src/routes/reports"));
app.use("/api/accounting", require("./src/routes/accounting"));
app.use("/api/manufacturing", require("./src/routes/manufacturing"));
app.use("/api/users", require("./src/routes/users"));
app.use("/api/locations", require("./src/routes/locations"));
app.use("/api/payments", require("./src/routes/payments"));
app.use("/api/plan-requests", require("./src/routes/plan-requests"));
app.use("/api/platform", require("./src/routes/platform"));
app.use("/api/backup", require("./src/routes/backup"));

// JSON error fallback so the SPA always gets a structured error
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.httpStatus || 500).json({ error: err.message || "Server error" });
});

app.listen(PORT, () => {
  console.log(`Accounting SaaS API running on http://localhost:${PORT}`);
});
