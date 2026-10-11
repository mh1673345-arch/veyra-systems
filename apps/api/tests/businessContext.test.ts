import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db/client.js";
import { formatBusinessContextForPrompt, loadBusinessContext } from "../src/services/businessContext.js";

describe("businessContext", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("assembles structured context from the database, including services and FAQs", async () => {
    const business = await prisma.business.create({
      data: {
        name: "Test Dental",
        description: "A test practice.",
        hours: "Mon-Fri 9am-5pm",
        location: "1 Test Way",
        contactPhone: "555-0100",
        services: { create: [{ name: "Cleaning", description: "Standard cleaning", priceLabel: "$100" }] },
        faqs: { create: [{ question: "Do you take walk-ins?", answer: "No, appointments only." }] }
      }
    });

    const context = await loadBusinessContext(business.id);

    expect(context.name).toBe("Test Dental");
    expect(context.hours).toBe("Mon-Fri 9am-5pm");
    expect(context.services).toEqual([
      { name: "Cleaning", description: "Standard cleaning", priceLabel: "$100" }
    ]);
    expect(context.faqs).toEqual([{ question: "Do you take walk-ins?", answer: "No, appointments only." }]);
  });

  it("throws a 404-shaped error for an unknown business", async () => {
    await expect(loadBusinessContext("does-not-exist")).rejects.toMatchObject({ status: 404 });
  });

  it("formats context into a prompt block without inventing content", async () => {
    const business = await prisma.business.create({
      data: {
        name: "Prompt Test Dental",
        hours: "Mon-Fri 9am-5pm",
        services: { create: [{ name: "Whitening", priceLabel: "$250" }] }
      }
    });

    const context = await loadBusinessContext(business.id);
    const prompt = formatBusinessContextForPrompt(context);

    expect(prompt).toContain("Prompt Test Dental");
    expect(prompt).toContain("Whitening");
    expect(prompt).toContain("$250");
    expect(prompt).toContain("Booking rules:");
    expect(prompt).toContain("Escalation rules:");
  });
});
