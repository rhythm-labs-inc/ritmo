import {z} from 'zod'

export const secretReferenceSchema = z.union([
  z.object({env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), prefix: z.string().max(32).regex(/^[\x20-\x7e]*$/).optional()}).strict(),
  z.object({keychain: z.string().min(1).max(128), prefix: z.string().max(32).regex(/^[\x20-\x7e]*$/).optional()}).strict(),
])

const reservedHeaders = /^(host|cookie|set-cookie|content-.*|accept|origin|referer|connection|upgrade|transfer-encoding|proxy-.*|mcp-.*|sec-.*)$/i
export const mcpAuthSchema = z.object({
  headers: z.record(z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/).refine((name) => !reservedHeaders.test(name), 'Use a custom authorization header, not a protocol or browser header'), secretReferenceSchema).optional(),
  oauth: z.object({
    account: z.string().min(1).max(128).optional(),
    client_id: z.string().min(1).max(2048).optional(),
    client_secret: secretReferenceSchema.optional(),
    token_endpoint_auth_method: z.enum(['client_secret_basic', 'client_secret_post']).optional(),
    callback_port: z.number().int().min(1024).max(65535).optional(),
    scope: z.string().max(2048).optional(),
  }).strict().refine((o) => !o.client_secret || Boolean(o.client_id), 'client_secret requires client_id')
    .refine((o) => !o.token_endpoint_auth_method || Boolean(o.client_id && o.client_secret), {message: 'token_endpoint_auth_method requires client_id and a client_secret reference', path: ['token_endpoint_auth_method']}).optional(),
}).strict().superRefine((auth, ctx) => {
  const names = Object.keys(auth.headers ?? {}).map((name) => name.toLowerCase())
  if (new Set(names).size !== names.length) ctx.addIssue({code: 'custom', message: 'Header names must be unique ignoring case'})
  if (auth.oauth && names.includes('authorization')) ctx.addIssue({code: 'custom', message: 'OAuth owns Authorization; remove the configured Authorization header'})
})

export type SecretReference = z.infer<typeof secretReferenceSchema>
export type McpAuthConfig = z.infer<typeof mcpAuthSchema>
