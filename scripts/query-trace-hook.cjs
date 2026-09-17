"use strict";

/* eslint-disable @typescript-eslint/no-require-imports -- NODE_OPTIONS preload hooks are CommonJS. */

/**
 * Hook اختباري يُحمّل عبر NODE_OPTIONS داخل خادم Next المعزول فقط.
 *
 * لا يكتب SQL ولا معاملات ولا قيمًا مرتبطة بالمستخدم. يسجل نوع العملية
 * واسم جدول معروف كي يستطيع اختبار HTTP فرض ميزانية Queries للصفحة.
 */
const traceFile = process.env.VERIFY_QUERY_TRACE_FILE;

if (traceFile) {
  const fs = require("node:fs");
  const pg = require("pg");
  const marker = Symbol.for("ae-ds-store.query-trace-installed");
  const prototype = pg.Client.prototype;

  if (!prototype[marker]) {
    const originalQuery = prototype.query;
    const knownTargets = [
      "FxRate",
      "AeApiLog",
      "session",
      "user",
      "Order",
      "PaymentIntent",
      "OrderJob",
      "RefundRequest",
    ];

    Object.defineProperty(prototype, marker, { value: true });
    prototype.query = function tracedQuery(...args) {
      try {
        const input = args[0];
        const sql =
          typeof input === "string"
            ? input
            : input && typeof input.text === "string"
              ? input.text
              : "";
        const verb = /^\s*([A-Za-z]+)/u.exec(sql)?.[1]?.toUpperCase() ?? "OTHER";
        const targets = knownTargets.filter((name) =>
          sql.includes(`"${name}"`),
        );
        fs.appendFileSync(
          traceFile,
          `${JSON.stringify({ verb, targets })}\n`,
          "utf8",
        );
      } catch {
        // القياس مساعد ولا يجوز أن يغيّر نجاح الاستعلام الأصلي.
      }
      return originalQuery.apply(this, args);
    };
  }
}
