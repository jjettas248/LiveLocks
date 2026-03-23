import { Resend } from "resend";

const apiKey = process.env.RESEND_API_KEY;

if (!apiKey) {
  console.warn("[email] WARNING: RESEND_API_KEY is not set. Transactional emails will not be sent.");
}

const resend = apiKey ? new Resend(apiKey) : null;

const FROM = "LiveLocks <team@livelocksai.app>";

const TEMPLATES = {
  welcome: process.env.RESEND_TEMPLATE_WELCOME || "welcome",
  howto: process.env.RESEND_TEMPLATE_HOWTO || "how-to",
  nudge: process.env.RESEND_TEMPLATE_NUDGE || "nudge",
  wall: process.env.RESEND_TEMPLATE_WALL || "wall-hit",
  winback: process.env.RESEND_TEMPLATE_WINBACK || "winback",
  proWelcome: process.env.RESEND_TEMPLATE_PRO_WELCOME || "pro-welcome",
  allSportsWelcome: process.env.RESEND_TEMPLATE_ALL_SPORTS_WELCOME || "all-sports-welcome",
} as const;

type TemplateSendOptions = {
  from: string;
  to: string;
  subject: string;
  template: {
    id: string;
    variables?: Record<string, string | number>;
  };
};

async function sendTemplateEmail(options: TemplateSendOptions): Promise<void> {
  if (!resend) {
    console.warn("EMAIL SKIPPED (no API key):", options.to);
    return;
  }
  await resend.emails.send(options as Parameters<typeof resend.emails.send>[0]);
}

export async function sendWelcomeEmail(to: string): Promise<void> {
  try {
    await sendTemplateEmail({
      from: FROM,
      to,
      subject: "Welcome to LiveLocks",
      template: { id: TEMPLATES.welcome },
    });
    console.log("EMAIL SENT:", to);
  } catch (error) {
    console.error("EMAIL FAILED:", error);
    throw error;
  }
}

export async function sendHowToEmail(to: string): Promise<void> {
  try {
    await sendTemplateEmail({
      from: FROM,
      to,
      subject: "How to use LiveLocks",
      template: { id: TEMPLATES.howto },
    });
    console.log("EMAIL SENT:", to);
  } catch (error) {
    console.error("EMAIL FAILED:", error);
    throw error;
  }
}

export async function sendNudgeEmail(to: string, playsUsed: number, remaining: number): Promise<void> {
  try {
    await sendTemplateEmail({
      from: FROM,
      to,
      subject: "Don't miss out on LiveLocks",
      template: {
        id: TEMPLATES.nudge,
        variables: { plays_used: playsUsed, remaining },
      },
    });
    console.log("EMAIL SENT:", to);
  } catch (error) {
    console.error("EMAIL FAILED:", error);
    throw error;
  }
}

export async function sendWallEmail(to: string): Promise<void> {
  try {
    await sendTemplateEmail({
      from: FROM,
      to,
      subject: "You've hit your free play limit — here's what you missed",
      template: { id: TEMPLATES.wall },
    });
    console.log("EMAIL SENT:", to);
  } catch (error) {
    console.error("EMAIL FAILED:", error);
    throw error;
  }
}

export async function sendWinbackEmail(to: string): Promise<void> {
  try {
    await sendTemplateEmail({
      from: FROM,
      to,
      subject: "We miss you at LiveLocks",
      template: { id: TEMPLATES.winback },
    });
    console.log("EMAIL SENT:", to);
  } catch (error) {
    console.error("EMAIL FAILED:", error);
    throw error;
  }
}

export async function sendProWelcomeEmail(to: string): Promise<void> {
  try {
    await sendTemplateEmail({
      from: FROM,
      to,
      subject: "Welcome to Pro",
      template: { id: TEMPLATES.proWelcome },
    });
    console.log("EMAIL SENT:", to);
  } catch (error) {
    console.error("EMAIL FAILED:", error);
    throw error;
  }
}

export async function sendAllSportsWelcomeEmail(to: string): Promise<void> {
  try {
    await sendTemplateEmail({
      from: FROM,
      to,
      subject: "Welcome to All Sports",
      template: { id: TEMPLATES.allSportsWelcome },
    });
    console.log("EMAIL SENT:", to);
  } catch (error) {
    console.error("EMAIL FAILED:", error);
    throw error;
  }
}

export async function sendVerificationEmail(to: string, token: string): Promise<void> {
  try {
    if (!resend) {
      console.warn("EMAIL SKIPPED (no API key):", to);
      return;
    }
    const verifyUrl = `https://livelocksai.app/api/auth/verify-email?token=${token}`;
    await resend.emails.send({
      from: FROM,
      to,
      subject: "Verify your LiveLocks email",
      html: `<p>Welcome to LiveLocks! Please verify your email by clicking the link below:</p><p><a href="${verifyUrl}">Verify Email</a></p><p>If you didn't create an account, you can safely ignore this email.</p>`,
    });
    console.log("EMAIL SENT:", to);
  } catch (error) {
    console.error("EMAIL FAILED:", error);
    throw error;
  }
}

export async function sendPaymentIssueEmail(to: string): Promise<void> {
  try {
    if (!resend) {
      console.warn("EMAIL SKIPPED (no API key):", to);
      return;
    }
    await resend.emails.send({
      from: FROM,
      to,
      subject: "Payment issue with your LiveLocks subscription",
      html: `<p>We noticed an issue with your LiveLocks subscription payment. Please update your payment method to continue enjoying full access.</p><p>Visit <a href="https://livelocksai.app">LiveLocks</a> to manage your account.</p>`,
    });
    console.log("EMAIL SENT:", to);
  } catch (error) {
    console.error("EMAIL FAILED:", error);
    throw error;
  }
}
