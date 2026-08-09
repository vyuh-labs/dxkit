CLASS zcl_orders_behavior DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    METHODS total RETURNING VALUE(rv_result) TYPE i.
ENDCLASS.
CLASS zcl_orders_behavior IMPLEMENTATION.
  METHOD total.
    rv_result = 1 +
