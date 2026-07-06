import { Platform, Text, TextInput } from "react-native";
import type { TextInputProps, TextProps, TextStyle } from "react-native";

type DefaultPropsComponent<Props> = {
  defaultProps?: Partial<Props>;
};

const webFontFamily = '"Segoe UI", Helvetica, Arial, sans-serif';
const appFontFamily = Platform.OS === "web" ? webFontFamily : undefined;

export const typography = {
  fontFamily: appFontFamily,
  text: appFontFamily ? ({ fontFamily: appFontFamily } satisfies TextStyle) : ({} satisfies TextStyle),
  weights: {
    regular: "400",
    medium: "500",
    semibold: "600",
    bold: "700",
  },
} as const;

export function configureDefaultTypography() {
  const textComponent = Text as unknown as DefaultPropsComponent<TextProps>;
  const inputComponent = TextInput as unknown as DefaultPropsComponent<TextInputProps>;

  textComponent.defaultProps = {
    ...textComponent.defaultProps,
    style: [typography.text, textComponent.defaultProps?.style],
  };

  inputComponent.defaultProps = {
    ...inputComponent.defaultProps,
    style: [typography.text, inputComponent.defaultProps?.style],
  };
}
