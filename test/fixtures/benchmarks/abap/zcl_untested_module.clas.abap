CLASS zcl_untested_module DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    METHODS shipping_cost IMPORTING iv_weight TYPE i RETURNING VALUE(rv_cost) TYPE i.
ENDCLASS.
CLASS zcl_untested_module IMPLEMENTATION.
  METHOD shipping_cost.
    rv_cost = iv_weight * 7.
  ENDMETHOD.
ENDCLASS.
