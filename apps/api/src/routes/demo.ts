import { Router } from "express";
import type { DemoBusinessInfo } from "@veyra/shared";
import { resolveDemoBusiness } from "../services/demo/demoBusiness.js";

/**
 * Which business the public Reception demo should talk to.
 *
 * Public, because the demo page itself is public — and it returns only a name
 * and an id, both of which the demo shows anyway. The point of the endpoint is
 * that the *server* decides, so a newly created workspace can never take the
 * demo over just by being the newest row.
 */
export const demoRouter = Router();

demoRouter.get("/demo/business", async (_req, res, next) => {
  try {
    const resolved = await resolveDemoBusiness();
    const body: DemoBusinessInfo = {
      businessId: resolved.businessId,
      name: resolved.name,
      source: resolved.source,
      pinned: resolved.pinned
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});
