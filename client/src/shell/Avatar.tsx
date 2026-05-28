// Avatar primitives — extracted from ChatApp.tsx.
//
// Two components + two style helpers that the whole shell leans on
// for rendering a user's avatar (uploaded image OR coloured initials
// tile). Used at ~15 sites inside ChatApp.tsx itself plus any future
// component that needs the same "image-when-set, initials-otherwise"
// fallback so a profile picture set in User Settings shows up
// everywhere consistently.

import type React from 'react';

/**
 * Build the inline-style object for an avatar tile.
 *
 * Uses backgroundColor (longhand) NOT background (shorthand) — the
 * shorthand resets background-size to `auto` inline, which beats the
 * .has-image { background-size: cover } CSS rule on specificity and
 * the image ended up cropped to its top-left corner.
 *
 * @param member  An object carrying `color` (per-username initials
 *                colour) and/or `avatarUrl` (uploaded picture).
 * @param size    Optional pixel size; sets width/height/fontSize.
 */
export function memberAvatarStyle(
  member: { color?: string; avatarUrl?: string },
  size?: number,
): React.CSSProperties {
  const style: React.CSSProperties = {};
  if (size) {
    style.width = size;
    style.height = size;
    style.fontSize = size * 0.4;
  }
  if (member.avatarUrl) {
    style.backgroundImage = `url(${member.avatarUrl})`;
    style.backgroundSize = 'cover';
    style.backgroundPosition = 'center';
    style.backgroundRepeat = 'no-repeat';
    style.color = 'transparent';
  } else {
    style.backgroundColor = member.color || 'var(--muted)';
  }
  return style;
}

/** Build the className for an avatar tile — adds `.has-image` so the
 *  CSS rules that hide initials when a picture is set can kick in. */
export function memberAvatarClass(
  member: { avatarUrl?: string },
  base: string,
): string {
  return member.avatarUrl ? base + ' has-image' : base;
}

interface AvatarMember {
  color?: string;
  avatarUrl?: string;
  initials?: string;
  status?: string;
}

/** Avatar tile WITH a presence dot when the member carries a `status`. */
export function Avatar({ member, size }: Readonly<{ member: AvatarMember; size?: number }>) {
  return (
    <div className={memberAvatarClass(member, 'avatar')} style={memberAvatarStyle(member, size)}>
      {!member.avatarUrl && member.initials}
      {member.status && <span className={`presence ${member.status}`}></span>}
    </div>
  );
}

/** Avatar tile WITHOUT the presence dot. Used in headers, mention
 *  pickers, and other places where the dot would be redundant or
 *  visually noisy. */
export function PlainAvatar({ member, size }: Readonly<{ member: AvatarMember; size?: number }>) {
  return (
    <div className={memberAvatarClass(member, 'avatar')} style={memberAvatarStyle(member, size)}>
      {!member.avatarUrl && member.initials}
    </div>
  );
}
