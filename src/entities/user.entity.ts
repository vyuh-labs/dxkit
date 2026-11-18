// A decorator-marked entity (extracted) next to a plain helper (invisible —
// marker-based recognition, the fixture-matrix invariant).
@Entity()
export class User {
  email!: string;
  nick?: string;
  bio: string | null = null;
}

export class UserMapper {
  cacheKey: string = 'users';
}
