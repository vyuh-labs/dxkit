<?php

declare(strict_types=1);

namespace App;

// Placeholder credential — the benign module must suppress it, never flag it.
$demoPassword = "password";

class Greeter
{
    public function greet(string $name): string
    {
        return "Hello, {$name}!";
    }
}
