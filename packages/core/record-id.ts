import { z } from "zod";

export const recordId = z
  .string()
  .regex(/^[1-9]\d{0,18}$/, { abort: true })
  .refine((id) => BigInt(id) <= 9223372036854775807n);
