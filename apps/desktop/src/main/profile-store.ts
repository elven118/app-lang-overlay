import fs from 'node:fs';
import path from 'node:path';

export type DesktopProfile = Record<string, unknown> & {
  profile_id: string;
};

const PROFILE_NAME_MAX_LENGTH = 64;
const INVALID_FILENAME_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f]/;

function profileKey(profileId: string): string {
  return profileId.normalize('NFKC').toLocaleLowerCase('en-US');
}

export function validateProfileId(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Profile name must be text');
  }
  const profileId = value.trim();
  if (!profileId || profileId.length > PROFILE_NAME_MAX_LENGTH) {
    throw new Error(`Profile name must contain 1-${PROFILE_NAME_MAX_LENGTH} characters`);
  }
  if (
    profileId === '.'
    || profileId === '..'
    || profileId.toLocaleLowerCase('en-US').endsWith('.json')
    || INVALID_FILENAME_CHARACTERS.test(profileId)
    || /[. ]$/.test(profileId)
  ) {
    throw new Error('Profile name contains characters that cannot be used in a filename');
  }
  return profileId;
}

export class ProfileStore {
  private readonly directory: string;
  private readonly activeProfilePath: string;

  constructor(directory: string) {
    this.directory = directory;
    this.activeProfilePath = path.join(directory, '.active-profile');
  }

  list(): string[] {
    this.ensureDirectory();
    return fs.readdirSync(this.directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name.slice(0, -'.json'.length))
      .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }));
  }

  exists(profileId: string): boolean {
    const validated = validateProfileId(profileId);
    const key = profileKey(validated);
    return this.list().some((candidate) => profileKey(candidate) === key);
  }

  resolveInitial(preferredProfileId?: string): string {
    if (preferredProfileId) {
      const preferred = validateProfileId(preferredProfileId);
      return this.exists(preferred) ? this.resolveExistingId(preferred) : preferred;
    }
    try {
      const persisted = validateProfileId(fs.readFileSync(this.activeProfilePath, 'utf-8'));
      if (this.exists(persisted)) return this.resolveExistingId(persisted);
    } catch {
      // A missing or stale state file falls back to the configured default.
    }
    return this.exists('demo') ? this.resolveExistingId('demo') : 'demo';
  }

  create(profileId: string, initial: Record<string, unknown> = {}): DesktopProfile {
    const validated = validateProfileId(profileId);
    if (this.exists(validated)) {
      throw new Error(`Profile already exists: ${validated}`);
    }
    const profile: DesktopProfile = { ...initial, profile_id: validated };
    delete profile.game_id;
    this.writeJson(this.pathFor(validated), profile);
    return profile;
  }

  load(profileId: string): DesktopProfile {
    const existingId = this.resolveExistingId(profileId);
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.pathFor(existingId), 'utf-8'));
    } catch (error) {
      throw new Error(`Unable to read profile ${existingId}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Profile ${existingId} must contain a JSON object`);
    }
    const profile = parsed as DesktopProfile & { game_id?: unknown };
    profile.profile_id = existingId;
    delete profile.game_id;
    return profile;
  }

  save(profileId: string, profile: Record<string, unknown>): DesktopProfile {
    const validated = validateProfileId(profileId);
    const saved: DesktopProfile = { ...profile, profile_id: validated };
    delete saved.game_id;
    this.writeJson(this.pathFor(validated), saved);
    return saved;
  }

  rename(profileId: string, nextProfileId: string): string {
    const existingId = this.resolveExistingId(profileId);
    const nextId = validateProfileId(nextProfileId);
    if (existingId === nextId) return existingId;
    if (this.exists(nextId)) {
      throw new Error(`Profile already exists: ${nextId}`);
    }
    const profile = this.load(existingId);
    profile.profile_id = nextId;
    this.writeJson(this.pathFor(nextId), profile);
    fs.unlinkSync(this.pathFor(existingId));
    return nextId;
  }

  setActive(profileId: string): string {
    const existingId = this.resolveExistingId(profileId);
    this.writeText(this.activeProfilePath, `${existingId}\n`);
    return existingId;
  }

  pathFor(profileId: string): string {
    return path.join(this.directory, `${validateProfileId(profileId)}.json`);
  }

  private resolveExistingId(profileId: string): string {
    const validated = validateProfileId(profileId);
    const key = profileKey(validated);
    const existing = this.list().find((candidate) => profileKey(candidate) === key);
    if (!existing) throw new Error(`Profile does not exist: ${validated}`);
    return existing;
  }

  private ensureDirectory(): void {
    fs.mkdirSync(this.directory, { recursive: true });
  }

  private writeJson(filePath: string, value: unknown): void {
    this.writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
  }

  private writeText(filePath: string, value: string): void {
    this.ensureDirectory();
    const temporaryPath = path.join(
      this.directory,
      `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
    );
    try {
      fs.writeFileSync(temporaryPath, value, 'utf-8');
      fs.renameSync(temporaryPath, filePath);
    } finally {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    }
  }
}
