import { z } from "zod";

/**
 * Canonical web-push payload contract.
 *
 * The server validates every outbound payload against this schema before it
 * reaches `webpush.sendNotification`, and the service worker (`client/public/sw.js`)
 * degrades gracefully on malformed JSON. Keeping the shape in one shared place
 * prevents the client deep-link reader and the server sender from drifting.
 */
export const pushNotificationPayloadSchema = z.object({
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(300),
  url: z.string().optional(),
  data: z.record(z.any()).optional(),
});

export type PushNotificationPayload = z.infer<typeof pushNotificationPayloadSchema>;
