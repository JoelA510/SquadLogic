import { z } from 'zod';

/**
 * The contact card a user keeps on their profile (Phase A2c, migration
 * 20261021010000). The same rules as `set_my_contact_card()` and the
 * `profiles_contact_*_check` constraints, so the form refuses what the server
 * would, with a message by the field instead of a database error.
 *
 * `share` is the user's choice: share these details, or show none. An unsaved
 * card (`share_contact` NULL on the profile) is neither, and the details the
 * league imported show until the user saves one.
 */
export const CONTACT_PHONE_PATTERN = /^\+?[0-9() .-]{7,32}$/;

const optionalTrimmed = (schema) =>
  z
    .string()
    .transform((value) => value.trim())
    .pipe(z.union([z.literal(''), schema]))
    .transform((value) => (value === '' ? null : value));

export const ContactCardSchema = z.object({
  phone: optionalTrimmed(
    z
      .string()
      .regex(
        CONTACT_PHONE_PATTERN,
        'Enter a phone number: digits, spaces, ( ) - . and a leading +.'
      )
  ),
  email: optionalTrimmed(z.string().max(254).email('Enter an email address.')),
  share: z.boolean({ error: 'Choose whether to share these details.' }),
});

/** The profile's saved card as form values; `share` is null until one is saved. */
export function contactCardFormOf(profile) {
  return {
    phone: profile?.contact_phone ?? '',
    email: profile?.contact_email ?? '',
    share: typeof profile?.share_contact === 'boolean' ? profile.share_contact : null,
  };
}
