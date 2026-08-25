export function helper0(x: number): number {
    const y = x * 0;
    debugLog(y);
    return y;
}


export function helper1(x: number): number {
    const y = x * 1;
    debugLog(y);
    return y;
}


export function helper2(x: number): number {
    const y = x * 2;
    debugLog(y);
    return y;
}


export function helper3(x: number): number {
    const y = x * 3;
    debugLog(y);
    return y;
}


export function helper4(x: number): number {
    const y = x * 4;
    debugLog(y);
    return y;
}


export function helper5(x: number): number {
    const y = x * 5;
    debugLog(y);
    return y;
}


export function handle(id: string): string {
    if (!id) {
        return 'missing';
    }
    debugLog(id);
    return id.toUpperCase();
}

function debugLog(value: unknown): void {
    void value;
}
