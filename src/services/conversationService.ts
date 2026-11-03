import {
  BotProvider,
  Connection,
  IncomingMessage,
  ShopBackend,
  Store,
  IntegrationError,
} from "../contracts";
import { normalizeDomain } from "../domain";

type Session = { step: "domain" | "username" | "password"; username?: string };
export class ConversationService {
  constructor(
    private readonly store: Store,
    private readonly backend: ShopBackend,
  ) {}

  async handle(
    connection: Connection,
    provider: BotProvider,
    message: IncomingMessage,
  ): Promise<void> {
    const key = `session:${connection.id}:${message.userId}`;
    const identity = message.userId;
    const reply = (text: string) =>
      provider.send(connection.token, message.chatId, text);
    const save = (session: Session) =>
      this.store.set(key, JSON.stringify(session), { ttl: 600 });
    const command = message.text
      .trim()
      .split(/\s/)[0]
      .split("@")[0]
      .toLowerCase();
    if (command === "/start") {
      await reply(
        "دامنه فروشگاه خود را وارد کنید؛ مانند pastelino.ir\n/cancel لغو\n/stop قطع اعلان‌ها",
      );
      await save({ step: "domain" });
      return;
    }
    if (command === "/cancel") {
      await this.store.delete(key);
      await reply("اتصال لغو شد. /start برای شروع دوباره");
      return;
    }
    if (command === "/stop" || command === "/unlink") {
      try { await this.backend.unlink(connection, identity); }
      catch (error) {
        if (error instanceof IntegrationError && [401, 403].includes(error.status)) {
          await reply("برای قطع اتصال ابتدا با /start وارد شوید؛ یا اتصال را از پنل فروشگاه قطع کنید.");
          return;
        }
        throw error;
      }
      await this.store.delete(key);
      await reply("اتصال حساب و اعلان‌های این فروشگاه قطع شد.");
      return;
    }
    if (command === "/status") {
      const linked = await this.backend.status(connection, identity);
      await reply(
        linked
          ? `اعلان‌های ${connection.domain} فعال است.`
          : "حساب مدیری متصل نیست. /start را بفرستید.",
      );
      return;
    }
    const raw = await this.store.get(key);
    if (!raw) {
      await reply("برای اتصال حساب مدیر، /start را بفرستید.");
      return;
    }
    const session = JSON.parse(raw) as Session;
    if (session.step === "domain") {
      if (normalizeDomain(message.text, connection.updateMode === "polling") !== connection.domain) {
        await reply(
          "دامنه متعلق به فروشگاه این ربات نیست. دامنه صحیح را وارد کنید.",
        );
        return;
      }
      await this.backend.verify(connection);
      await reply(
        "دامنه تأیید شد. نام کاربری یا شماره تلفن حساب مدیر را وارد کنید.",
      );
      await save({ step: "username" });
      return;
    }
    if (session.step === "username") {
      const username = message.text.trim();
      if (!username || username.length > 128 || username.startsWith("/")) {
        await reply("نام کاربری یا شماره تلفن معتبر وارد کنید.");
        return;
      }
      await reply(
        "رمز عبور حساب مدیر را وارد کنید. پیام رمز پیش از بررسی حذف می‌شود و رمز ذخیره نمی‌شود.\n/cancel برای لغو",
      );
      await save({ step: "password", username });
      return;
    }
    if (session.step === "password" && session.username) {
      await provider.deleteMessage(
        connection.token,
        message.chatId,
        message.messageId,
      );
      let success: boolean;
      try {
        success = await this.backend.authenticate(connection, {
          externalUserId: identity, chatId: message.chatId, username: session.username, password: message.text,
        });
      } catch {
        await this.store.delete(key);
        await reply("ارتباط با فروشگاه برقرار نشد. کمی بعد با /start دوباره تلاش کنید.");
        return;
      }
      await this.store.delete(key);
      await reply(
        success
          ? `حساب مدیر ${connection.domain} متصل شد.\n/status وضعیت\n/stop قطع اعلان‌ها`
          : "ورود ناموفق بود. حساب باید مدیر فعال فروشگاه باشد. قفل یا الزام احراز هویت دومرحله‌ای را در پنل بررسی کنید. /start برای تلاش دوباره",
      );
    }
  }
}
