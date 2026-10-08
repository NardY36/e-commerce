import { Router, type Request, type Response, type NextFunction } from "express";
import { env } from "../env.js";
import { log } from "../logger.js";
import { verifyInitData, type TelegramUser } from "./verifyInitData.js";
import { STORE_INVENTORY } from "./inventory.js";

// Augment Express's Request so downstream handlers get a typed, verified user.
interface AuthedRequest extends Request {
  merchant?: TelegramUser;
}

/**
 * Auth middleware for Mini App calls. The webview sends Telegram's initData in the
 * Authorization header as `tma <initData>` (the emerging convention). We verify the
 * HMAC signature server-side — the client can lie about anything except the hash,
 * which only Telegram + our bot token can produce.
 */
function requireMerchant(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.header("authorization") ?? "";
  const initData = header.startsWith("tma ") ? header.slice(4) : "";

  const result = verifyInitData(initData, env.TELEGRAM_BOT_TOKEN);
  if (!result.ok) {
    log.warn("miniapp auth rejected", { reason: result.reason });
    return res.status(401).json({ error: "unauthorized", reason: result.reason });
  }
  req.merchant = result.user;
  next();
}

export const miniappRouter = Router();

/** Who am I — handy for the webview to greet the merchant by name. */
miniappRouter.get("/me", requireMerchant, (req: AuthedRequest, res: Response) => {
  res.json({ merchant: req.merchant });
});

/** The mock inventory list shown inside the Mini App. */
miniappRouter.get("/inventory", requireMerchant, (req: AuthedRequest, res: Response) => {
  res.json({
    merchant: req.merchant,
    store: "Bole Cosmetics",
    items: STORE_INVENTORY,
  });
});
