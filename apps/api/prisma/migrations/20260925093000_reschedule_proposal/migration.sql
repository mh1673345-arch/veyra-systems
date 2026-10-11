-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN     "rescheduleProposalExpires" TIMESTAMP(3),
ADD COLUMN     "rescheduleProposedEnd" TIMESTAMP(3),
ADD COLUMN     "rescheduleProposedStart" TIMESTAMP(3);

