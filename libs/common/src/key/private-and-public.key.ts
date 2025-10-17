import { readFileSync } from 'fs';

export const privateKey = readFileSync('private.pem');
export const publicKey = readFileSync('public.pem');
