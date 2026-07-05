#!/usr/bin/env node
/**
 * Generate a local-dev JWT for API calls. Reads JWT_* vars from .env (via dotenv).
 * Usage: node scripts/generate-dev-token.js [subject]
 */
import { config } from 'dotenv';
import jwt from 'jsonwebtoken';

config();

const subject = process.argv[2] ?? 'local-dev-user';
const secret = process.env.JWT_SECRET;
const issuer = process.env.JWT_ISSUER;
const audience = process.env.JWT_AUDIENCE;

if (!secret || !issuer || !audience) {
  console.error('Missing JWT_SECRET, JWT_ISSUER, or JWT_AUDIENCE in environment (.env).');
  process.exit(1);
}

const token = jwt.sign({ sub: subject }, secret, {
  issuer,
  audience,
  expiresIn: '1h',
});

console.log(token);
