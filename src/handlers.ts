// header 0
// header 1
// header 2
// header 3
// header 4
// header 5
// header 6
// header 7
// header 8
// header 9
// header 10
// header 11
// header 12
// header 13
// header 14
// header 15
// header 16
// header 17
// header 18
// header 19
// header 20
// header 21
// header 22
// header 23
// header 24
// header 25
// header 26
// header 27
// header 28
// header 29
// header 30
// header 31
// header 32
// header 33
// header 34
// header 35
// header 36
// header 37
// header 38
// header 39
export function helper0(x: number): number {
  return x + 0;
}

export function helper1(x: number): number {
  return x + 1;
}

export function helper2(x: number): number {
  return x + 2;
}

export function helper3(x: number): number {
  return x + 3;
}

export function helper4(x: number): number {
  return x + 4;
}

export function helper5(x: number): number {
  const y = x * 5;
  return y;
}

export function helper6(x: number): number {
  const y = x * 6;
  return y;
}

export function helper7(x: number): number {
  const y = x * 7;
  return y;
}

export function handle(req: Request): Response {
  const id = req.id;
  if (!id) {
    return notFound();
  }
  console.log(id);
  return ok(id);
}

export const VERSION = 1;
