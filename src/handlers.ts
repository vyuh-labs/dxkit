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
