CLASS zcl_duplications DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    METHODS calc_alpha RETURNING VALUE(rv_result) TYPE i.
    METHODS calc_beta RETURNING VALUE(rv_result) TYPE i.
ENDCLASS.
CLASS zcl_duplications IMPLEMENTATION.
  METHOD calc_alpha.
    DATA(lv_total) = 0.
    DATA(lv_index) = 0.
    WHILE lv_index < 25.
      lv_index = lv_index + 1.
      IF lv_index MOD 3 = 0.
        lv_total = lv_total + lv_index * 2.
      ELSEIF lv_index MOD 5 = 0.
        lv_total = lv_total + lv_index * 3.
      ELSE.
        lv_total = lv_total + lv_index.
      ENDIF.
    ENDWHILE.
    IF lv_total > 100.
      lv_total = lv_total - 100.
    ENDIF.
    rv_result = lv_total.
  ENDMETHOD.
  METHOD calc_beta.
    DATA(lv_total) = 0.
    DATA(lv_index) = 0.
    WHILE lv_index < 25.
      lv_index = lv_index + 1.
      IF lv_index MOD 3 = 0.
        lv_total = lv_total + lv_index * 2.
      ELSEIF lv_index MOD 5 = 0.
        lv_total = lv_total + lv_index * 3.
      ELSE.
        lv_total = lv_total + lv_index.
      ENDIF.
    ENDWHILE.
    IF lv_total > 100.
      lv_total = lv_total - 100.
    ENDIF.
    rv_result = lv_total.
  ENDMETHOD.
ENDCLASS.
