-- فهرس فريد جزئي: نيّة دفع مفتوحة واحدة لكل طلبية على الأكثر.
-- Prisma لا يعبّر عن الفهرس الجزئي تصريحيًا، فيُكتب خامًا هنا. يمنع سباق
-- النقر المزدوج على «ادفع الآن» من إنشاء فاتورتين حيّتين لدى المزوّد.
CREATE UNIQUE INDEX "one_open_intent_per_order"
  ON "PaymentIntent" ("orderId")
  WHERE "status" IN ('REQUIRES_ACTION', 'PENDING');
