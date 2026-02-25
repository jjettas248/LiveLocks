import { z } from 'zod';
import { calculateProbabilitySchema, players } from './schema';

export const errorSchemas = {
  validation: z.object({ message: z.string(), field: z.string().optional() }),
  notFound: z.object({ message: z.string() }),
  internal: z.object({ message: z.string() }),
};

export const api = {
  players: {
    list: {
      method: 'GET' as const,
      path: '/api/players' as const,
      responses: {
        200: z.array(z.custom<typeof players.$inferSelect>()),
      },
    },
  },
  teams: {
    list: {
      method: 'GET' as const,
      path: '/api/teams' as const,
      responses: {
        200: z.array(z.string()),
      },
    }
  },
  calculator: {
    calculate: {
      method: 'POST' as const,
      path: '/api/calculate' as const,
      input: calculateProbabilitySchema,
      responses: {
        200: z.custom<import('./schema').CalculateProbabilityResponse>(),
        400: errorSchemas.validation,
        404: errorSchemas.notFound,
      },
    },
  },
};

export function buildUrl(path: string, params?: Record<string, string | number>): string {
  let url = path;
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (url.includes(`:${key}`)) {
        url = url.replace(`:${key}`, String(value));
      }
    });
  }
  return url;
}
