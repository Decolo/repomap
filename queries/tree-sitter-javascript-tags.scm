(method_definition
  name: (property_identifier) @name.definition.method
) @definition.method

(class_declaration
  name: (identifier) @name.definition.class
) @definition.class

(function_declaration
  name: (identifier) @name.definition.function
) @definition.function

(generator_function_declaration
  name: (identifier) @name.definition.function
) @definition.function

(lexical_declaration
  (variable_declarator
    name: (identifier) @name.definition.function
    value: [
      (arrow_function)
      (function_expression)
      (generator_function)
    ]
  )
) @definition.function

(variable_declaration
  (variable_declarator
    name: (identifier) @name.definition.function
    value: [
      (arrow_function)
      (function_expression)
      (generator_function)
    ]
  )
) @definition.function

(assignment_expression
  left: [
    (identifier) @name.definition.function
    (member_expression
      property: (property_identifier) @name.definition.function
    )
  ]
  right: [
    (arrow_function)
    (function_expression)
    (generator_function)
  ]
) @definition.function

(pair
  key: (property_identifier) @name.definition.function
  value: [
    (arrow_function)
    (function_expression)
    (generator_function)
  ]
) @definition.function

(
  (call_expression
    function: (identifier) @name.reference.call
  ) @reference.call
  (#not-match? @name.reference.call "^(require)$")
)

(call_expression
  function: (member_expression
    property: (property_identifier) @name.reference.call
  )
) @reference.call

(new_expression
  constructor: (identifier) @name.reference.class
) @reference.class
