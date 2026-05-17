export type Validator = "free_text" | "name" | "email" | "phone" | "age";

export type RedactionRule = {
  key: string;
  title: string;
  description: string;
  enabledByDefault: boolean;
  validator: Validator;
  labels: string[];
  regex?: RegExp;
};

export const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
export const phonePattern = /(?<!\d)(?:\+?\d[\d\s().-]{7,}\d)(?!\d)/;
export const agePattern = /\b(?:[1-9][0-9]?|1[01][0-9]|120)\b/;

export const defaultRules: RedactionRule[] = [
  {
    key: "name",
    title: "Names",
    description: "Full name, first name, last name, surname, signature answers",
    enabledByDefault: true,
    validator: "name",
    labels: [
      "your name",
      "full name",
      "name",
      "first name",
      "given name",
      "last name",
      "second name",
      "surname",
      "family name",
      "middle name",
      "participant name",
      "signature",
      "electronic signature"
    ]
  },
  {
    key: "email",
    title: "Email addresses",
    description: "Email answers after email fields",
    enabledByDefault: true,
    validator: "email",
    regex: emailPattern,
    labels: ["your email", "email", "e-mail", "email address", "mail"]
  },
  {
    key: "phone",
    title: "Phone numbers",
    description: "Phone, mobile, telephone, contact number",
    enabledByDefault: false,
    validator: "phone",
    regex: phonePattern,
    labels: ["phone", "phone number", "mobile", "telephone", "contact number"]
  },
  {
    key: "age",
    title: "Age",
    description: "Age questions and numeric age answers",
    enabledByDefault: false,
    validator: "age",
    regex: agePattern,
    labels: ["what's your age", "what is your age", "age"]
  },
  {
    key: "address",
    title: "Addresses",
    description: "Address, city, state, ZIP or postal code answers",
    enabledByDefault: false,
    validator: "free_text",
    labels: ["address", "street address", "city", "state", "zip", "zip code", "postal code"]
  },
  {
    key: "demographics",
    title: "Demographic answers",
    description: "Race, ethnicity, gender, and disability question answers",
    enabledByDefault: false,
    validator: "free_text",
    labels: [
      "are you hispanic or latino",
      "what is your racial category",
      "gender",
      "are you legally blind or visually impaired"
    ]
  }
];

