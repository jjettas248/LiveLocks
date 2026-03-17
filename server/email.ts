import { Resend } from "resend";

const apiKey = process.env.RESEND_API_KEY;

if (!apiKey) {
  console.warn("[email] RESEND_API_KEY is not set. Transactional emails will not be sent.");
}

const resend = apiKey ? new Resend(apiKey) : null;

const FROM = "LiveLocks <team@livelocksai.app>";

const TEMPLATES = {
  welcome: process.env.RESEND_TEMPLATE_WELCOME || "welcome",
  howto: process.env.RESEND_TEMPLATE_HOWTO || "how-to",
  nudge: process.env.RESEND_TEMPLATE_NUDGE || "nudge",
  wall: process.env.RESEND_TEMPLATE_WALL || "wall",
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
  if (!resend) return;
  await resend.emails.send(options as Parameters<typeof resend.emails.send>[0]);
}

export async function sendWelcomeEmail(to: string): Promise<void> {
  await sendTemplateEmail({
    from: FROM,
    to,
    subject: "Welcome to LiveLocks",
    template: { id: TEMPLATES.welcome },
  });
}

export async function sendHowToEmail(to: string): Promise<void> {
  await sendTemplateEmail({
    from: FROM,
    to,
    subject: "How to use LiveLocks",
    template: { id: TEMPLATES.howto },
  });
}

export async function sendNudgeEmail(to: string, playsUsed: number, remaining: number): Promise<void> {
  await sendTemplateEmail({
    from: FROM,
    to,
    subject: "Don't miss out on LiveLocks",
    template: {
      id: TEMPLATES.nudge,
      variables: { plays_used: playsUsed, remaining },
    },
  });
}

export async function sendWallEmail(to: string, trialCode?: string): Promise<void> {
  const variables: Record<string, string | number> = {};
  if (trialCode) {
    variables.trial_code = trialCode;
  }
  await sendTemplateEmail({
    from: FROM,
    to,
    subject: "You've hit the free play limit",
    template: {
      id: TEMPLATES.wall,
      ...(Object.keys(variables).length > 0 ? { variables } : {}),
    },
  });
}

export async function sendWinbackEmail(to: string): Promise<void> {
  await sendTemplateEmail({
    from: FROM,
    to,
    subject: "We miss you at LiveLocks",
    template: { id: TEMPLATES.winback },
  });
}

export async function sendProWelcomeEmail(to: string): Promise<void> {
  await sendTemplateEmail({
    from: FROM,
    to,
    subject: "Welcome to Pro",
    template: { id: TEMPLATES.proWelcome },
  });
}

export async function sendAllSportsWelcomeEmail(to: string): Promise<void> {
  await sendTemplateEmail({
    from: FROM,
    to,
    subject: "Welcome to All Sports",
    template: { id: TEMPLATES.allSportsWelcome },
  });
}
