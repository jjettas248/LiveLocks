let twilioClient: any = null;

function getClient() {
  if (twilioClient) return twilioClient;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  try {
    const twilio = require("twilio");
    twilioClient = twilio(sid, token);
  } catch {
    console.warn("[twilio] twilio package not installed — SMS disabled");
    return null;
  }
  return twilioClient;
}

export async function sendSms(to: string, body: string): Promise<void> {
  const fromNumber = process.env.TWILIO_FROM_NUMBER;
  if (!fromNumber) {
    console.warn("[twilio] TWILIO_FROM_NUMBER not set — SMS skipped");
    return;
  }
  const client = getClient();
  if (!client) {
    console.warn("[twilio] Twilio not configured — SMS skipped");
    return;
  }
  await client.messages.create({ body, from: fromNumber, to });
}
