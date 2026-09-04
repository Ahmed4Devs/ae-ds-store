-- DropForeignKey
ALTER TABLE "PaymentIntent" DROP CONSTRAINT "PaymentIntent_orderId_fkey";

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "needsManualReview" BOOLEAN NOT NULL DEFAULT false;

-- AddForeignKey
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
