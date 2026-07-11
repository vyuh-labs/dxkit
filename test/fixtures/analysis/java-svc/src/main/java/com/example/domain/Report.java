// A JPA-marked entity (extracted) next to an unmarked helper (invisible).
// Optionality is annotation-carried: nullable=true → optional; an
// unannotated column stays an honest unknown.
package com.example.domain;

@Entity
public class Report {
  @Id
  @Column(nullable = false)
  private Long id;

  @Column(name = "report_title", nullable = false)
  private String title;

  @Column(nullable = true)
  private String note;

  private String internalState;
}
