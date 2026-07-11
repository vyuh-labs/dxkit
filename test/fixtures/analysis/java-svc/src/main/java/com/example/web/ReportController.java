// Served surface: Spring annotations with the class-level prefix — the form
// that mis-pathed without ancestor prefix composition.
package com.example.web;

@RestController
@RequestMapping("/api/reports")
public class ReportController {
  // Demo credential placeholder — the benign module must suppress it.
  private static final String password = "password";

  @GetMapping("/{id}")
  public Report one(@PathVariable long id) { return null; }

  @PostMapping
  public Report create(@RequestBody Report r) { return null; }
}
