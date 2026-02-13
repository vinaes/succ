/**
 * Tree-sitter S-expression queries for symbol extraction.
 *
 * Each language has a query string that captures:
 * - @definition.function / @definition.method — function/method definitions
 * - @definition.class — class definitions
 * - @definition.interface — interface/trait/protocol definitions
 * - @definition.type — type aliases, enums, structs
 * - @name — the identifier name within each definition
 * - @doc — doc comments adjacent to definitions
 *
 * These queries are used by extractor.ts to pull structured metadata from AST.
 */

/**
 * Query definitions per language.
 * Key = tree-sitter language name (matches EXTENSION_TO_LANGUAGE values).
 */
export const LANGUAGE_QUERIES: Record<string, string> = {
  typescript: `
    ; Functions
    (function_declaration
      name: (identifier) @name) @definition.function

    ; Arrow functions assigned to const/let/var
    (lexical_declaration
      (variable_declarator
        name: (identifier) @name
        value: (arrow_function))) @definition.function

    ; Function expressions assigned to const/let/var
    (lexical_declaration
      (variable_declarator
        name: (identifier) @name
        value: (function_expression))) @definition.function

    ; Classes
    (class_declaration
      name: (type_identifier) @name) @definition.class

    ; Interfaces
    (interface_declaration
      name: (type_identifier) @name) @definition.interface

    ; Type aliases
    (type_alias_declaration
      name: (type_identifier) @name) @definition.type

    ; Enums
    (enum_declaration
      name: (identifier) @name) @definition.type

    ; Methods inside classes
    (method_definition
      name: (property_identifier) @name) @definition.method

    ; Doc comments (JSDoc)
    (comment) @doc
  `,

  tsx: `
    ; Functions
    (function_declaration
      name: (identifier) @name) @definition.function

    ; Arrow functions assigned to const/let/var
    (lexical_declaration
      (variable_declarator
        name: (identifier) @name
        value: (arrow_function))) @definition.function

    ; Classes
    (class_declaration
      name: (type_identifier) @name) @definition.class

    ; Interfaces
    (interface_declaration
      name: (type_identifier) @name) @definition.interface

    ; Type aliases
    (type_alias_declaration
      name: (type_identifier) @name) @definition.type

    ; Enums
    (enum_declaration
      name: (identifier) @name) @definition.type

    ; Methods
    (method_definition
      name: (property_identifier) @name) @definition.method

    ; Doc comments
    (comment) @doc
  `,

  javascript: `
    ; Functions
    (function_declaration
      name: (identifier) @name) @definition.function

    ; Arrow/function assigned to variable
    (lexical_declaration
      (variable_declarator
        name: (identifier) @name
        value: (arrow_function))) @definition.function

    (lexical_declaration
      (variable_declarator
        name: (identifier) @name
        value: (function_expression))) @definition.function

    ; Classes
    (class_declaration
      name: (identifier) @name) @definition.class

    ; Methods
    (method_definition
      name: (property_identifier) @name) @definition.method

    ; Doc comments
    (comment) @doc
  `,

  python: `
    ; Functions
    (function_definition
      name: (identifier) @name) @definition.function

    ; Classes
    (class_definition
      name: (identifier) @name) @definition.class

    ; Decorated definitions (decorators are siblings, not captured separately)

    ; Doc comments (docstrings are expression_statements with string)
    (expression_statement
      (string)) @doc

    ; Comments
    (comment) @doc
  `,

  go: `
    ; Functions
    (function_declaration
      name: (identifier) @name) @definition.function

    ; Methods (function with receiver)
    (method_declaration
      name: (field_identifier) @name) @definition.method

    ; Types — struct
    (type_declaration
      (type_spec
        name: (type_identifier) @name
        type: (struct_type))) @definition.class

    ; Types — interface
    (type_declaration
      (type_spec
        name: (type_identifier) @name
        type: (interface_type))) @definition.interface

    ; Types — other (type alias)
    (type_declaration
      (type_spec
        name: (type_identifier) @name)) @definition.type

    ; Comments
    (comment) @doc
  `,

  rust: `
    ; Functions
    (function_item
      name: (identifier) @name) @definition.function

    ; Structs
    (struct_item
      name: (type_identifier) @name) @definition.class

    ; Enums
    (enum_item
      name: (type_identifier) @name) @definition.type

    ; Traits
    (trait_item
      name: (type_identifier) @name) @definition.interface

    ; Impl blocks
    (impl_item
      type: (type_identifier) @name) @definition.class

    ; Type aliases
    (type_item
      name: (type_identifier) @name) @definition.type

    ; Comments
    (line_comment) @doc
    (block_comment) @doc
  `,

  java: `
    ; Classes
    (class_declaration
      name: (identifier) @name) @definition.class

    ; Interfaces
    (interface_declaration
      name: (identifier) @name) @definition.interface

    ; Enums
    (enum_declaration
      name: (identifier) @name) @definition.type

    ; Methods
    (method_declaration
      name: (identifier) @name) @definition.method

    ; Constructors
    (constructor_declaration
      name: (identifier) @name) @definition.method

    ; Comments
    (line_comment) @doc
    (block_comment) @doc
  `,

  kotlin: `
    ; Functions
    (function_declaration
      (simple_identifier) @name) @definition.function

    ; Classes (Kotlin uses class_declaration for both classes and interfaces;
    ; we extract all as class — consumers can distinguish via modifiers if needed)
    (class_declaration
      (type_identifier) @name) @definition.class

    ; Objects
    (object_declaration
      (type_identifier) @name) @definition.class

    ; Comments
    (line_comment) @doc
    (multiline_comment) @doc
  `,

  c: `
    ; Functions
    (function_definition
      declarator: (function_declarator
        declarator: (identifier) @name)) @definition.function

    ; Structs
    (struct_specifier
      name: (type_identifier) @name) @definition.class

    ; Enums
    (enum_specifier
      name: (type_identifier) @name) @definition.type

    ; Typedefs
    (type_definition
      declarator: (type_identifier) @name) @definition.type

    ; Comments
    (comment) @doc
  `,

  cpp: `
    ; Functions
    (function_definition
      declarator: (function_declarator
        declarator: (identifier) @name)) @definition.function

    ; Qualified function definitions (e.g. MyClass::method)
    (function_definition
      declarator: (function_declarator
        declarator: (qualified_identifier
          name: (identifier) @name))) @definition.method

    ; Classes
    (class_specifier
      name: (type_identifier) @name) @definition.class

    ; Structs
    (struct_specifier
      name: (type_identifier) @name) @definition.class

    ; Enums
    (enum_specifier
      name: (type_identifier) @name) @definition.type

    ; Namespaces
    (namespace_definition
      name: (identifier) @name) @definition.type

    ; Templates (template declarations contain the actual definition)

    ; Comments
    (comment) @doc
  `,

  c_sharp: `
    ; Classes
    (class_declaration
      name: (identifier) @name) @definition.class

    ; Interfaces
    (interface_declaration
      name: (identifier) @name) @definition.interface

    ; Structs
    (struct_declaration
      name: (identifier) @name) @definition.class

    ; Enums
    (enum_declaration
      name: (identifier) @name) @definition.type

    ; Methods
    (method_declaration
      name: (identifier) @name) @definition.method

    ; Properties
    (property_declaration
      name: (identifier) @name) @definition.function

    ; Constructors
    (constructor_declaration
      name: (identifier) @name) @definition.method

    ; Comments
    (comment) @doc
  `,

  php: `
    ; Functions
    (function_definition
      name: (name) @name) @definition.function

    ; Classes
    (class_declaration
      name: (name) @name) @definition.class

    ; Interfaces
    (interface_declaration
      name: (name) @name) @definition.interface

    ; Traits
    (trait_declaration
      name: (name) @name) @definition.interface

    ; Methods
    (method_declaration
      name: (name) @name) @definition.method

    ; Comments
    (comment) @doc
  `,

  ruby: `
    ; Methods
    (method
      name: (identifier) @name) @definition.method

    ; Singleton methods (self.method)
    (singleton_method
      name: (identifier) @name) @definition.method

    ; Classes
    (class
      name: (constant) @name) @definition.class

    ; Modules
    (module
      name: (constant) @name) @definition.class

    ; Comments
    (comment) @doc
  `,
};

/**
 * Get the query string for a given language.
 * Returns undefined if no query is defined for that language.
 */
export function getQueryForLanguage(language: string): string | undefined {
  return LANGUAGE_QUERIES[language];
}

/**
 * Get all languages that have query definitions.
 */
export function getSupportedQueryLanguages(): string[] {
  return Object.keys(LANGUAGE_QUERIES);
}
