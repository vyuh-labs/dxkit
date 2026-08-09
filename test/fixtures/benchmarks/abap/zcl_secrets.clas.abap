CLASS zcl_secrets DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    METHODS connect.
ENDCLASS.
CLASS zcl_secrets IMPLEMENTATION.
  METHOD connect.
    " Deliberate benchmark credential (fake) — the secrets matrix cell.
    DATA(lv_key) = 'AKIAIOSFODNN7EXAMPLE'.
  ENDMETHOD.
ENDCLASS.
