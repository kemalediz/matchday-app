"use server";

import { db } from "@/lib/db";
import { signUpSchema } from "@/lib/validations";
import { sendVerificationEmail } from "@/lib/email";
import bcrypt from "bcryptjs";
import crypto from "crypto";

export async function signUpWithEmail(formData: {
  name: string;
  email: string;
  password: string;
}) {
  const parsed = signUpSchema.parse(formData);

  const existing = await db.user.findUnique({
    where: { email: parsed.email },
  });

  if (existing) {
    if (existing.password) {
      throw new Error("An account with this email already exists. Please sign in.");
    }
    // User exists via Google OAuth — let them set a password
    const hashedPassword = await bcrypt.hash(parsed.password, 12);
    await db.user.update({
      where: { id: existing.id },
      data: { password: hashedPassword },
    });
  } else {
    const hashedPassword = await bcrypt.hash(parsed.password, 12);
    await db.user.create({
      data: {
        name: parsed.name,
        email: parsed.email,
        password: hashedPassword,
      },
    });
  }

  // Generate 6-digit verification code
  const code = crypto.randomInt(100000, 999999).toString();
  const expires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  // Delete old tokens for this email
  await db.verificationToken.deleteMany({
    where: { identifier: parsed.email },
  });

  await db.verificationToken.create({
    data: {
      identifier: parsed.email,
      token: code,
      expires,
    },
  });

  await sendVerificationEmail(parsed.email, code, parsed.name);

  return { success: true };
}

export async function verifyEmail(email: string, code: string) {
  const token = await db.verificationToken.findFirst({
    where: {
      identifier: email,
      token: code,
      expires: { gt: new Date() },
    },
  });

  if (!token) {
    throw new Error("Invalid or expired verification code");
  }

  await db.user.update({
    where: { email },
    data: { emailVerified: new Date() },
  });

  await db.verificationToken.deleteMany({
    where: { identifier: email },
  });

  return { success: true };
}

export async function resendVerification(email: string) {
  const user = await db.user.findUnique({ where: { email } });
  if (!user) throw new Error("No account found with this email");
  if (user.emailVerified) throw new Error("Email is already verified");

  const code = crypto.randomInt(100000, 999999).toString();
  const expires = new Date(Date.now() + 10 * 60 * 1000);

  await db.verificationToken.deleteMany({
    where: { identifier: email },
  });

  await db.verificationToken.create({
    data: {
      identifier: email,
      token: code,
      expires,
    },
  });

  await sendVerificationEmail(email, code, user.name);

  return { success: true };
}
