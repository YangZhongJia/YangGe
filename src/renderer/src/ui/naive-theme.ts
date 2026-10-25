import type { GlobalThemeOverrides } from 'naive-ui'

const fontFamily =
  "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif"

const componentOverrides: GlobalThemeOverrides = {
  Button: {
    heightSmall: '30px',
    heightMedium: '34px',
    borderRadiusSmall: '6px',
    borderRadiusMedium: '6px',
    fontSizeSmall: '13px',
    fontSizeMedium: '13px'
  },
  Input: {
    heightSmall: '30px',
    heightMedium: '34px',
    borderRadius: '6px',
    fontSizeSmall: '13px',
    fontSizeMedium: '13px',
    paddingSmall: '0 10px',
    paddingMedium: '0 10px'
  },
  Radio: {
    buttonHeightSmall: '30px',
    buttonHeightMedium: '32px',
    buttonBorderRadius: '6px',
    fontSizeSmall: '13px',
    fontSizeMedium: '13px'
  },
  Select: {
    menuBoxShadow: '0 4px 18px rgba(29, 45, 68, 0.12)',
    peers: {
      InternalSelection: {
        textColor: 'var(--text-1)',
        fontSizeMedium: '13px'
      }
    }
  },
  Switch: {
    railHeightMedium: '20px',
    railWidthMedium: '38px',
    buttonHeightMedium: '16px',
    buttonWidthMedium: '16px'
  }
}

export interface AccentPalette {
  primary: string
  hover: string
  pressed: string
}

const INDIGO_LIGHT: AccentPalette = { primary: '#5850ec', hover: '#4f46dc', pressed: '#4338c9' }
const INDIGO_DARK: AccentPalette = { primary: '#7b76f0', hover: '#8d89f5', pressed: '#6a64e8' }

/** 主题色换装（决议 #327）：naive 组件主色随 accent 联动；深浅分别取色 */
export function teahouseLightThemeOverrides(
  accent: AccentPalette = INDIGO_LIGHT
): GlobalThemeOverrides {
  const { primary, hover, pressed } = accent
  return {
    ...componentOverrides,
    common: {
      primaryColor: primary,
      primaryColorHover: hover,
      primaryColorPressed: pressed,
      primaryColorSuppl: primary,
      infoColor: primary,
      infoColorHover: hover,
      infoColorPressed: pressed,
      infoColorSuppl: primary,
      textColorBase: '#1b1e24',
      textColor1: '#1b1e24',
      textColor2: '#5d6470',
      textColor3: '#878e9a',
      placeholderColor: '#9aa1ad',
      borderColor: '#dcdfe6',
      dividerColor: '#e8eaef',
      bodyColor: '#ffffff',
      cardColor: '#ffffff',
      modalColor: '#ffffff',
      popoverColor: '#ffffff',
      inputColor: '#ffffff',
      hoverColor: '#edeff3',
      pressedColor: '#e6e8fb',
      fontFamily,
      borderRadius: '12px',
      borderRadiusSmall: '8px',
      fontSize: '13px',
      heightSmall: '30px',
      heightMedium: '34px'
    }
  }
}

export function teahouseDarkThemeOverrides(
  accent: AccentPalette = INDIGO_DARK
): GlobalThemeOverrides {
  const { primary, hover, pressed } = accent
  return {
    ...componentOverrides,
    common: {
      primaryColor: primary,
      primaryColorHover: hover,
      primaryColorPressed: pressed,
      primaryColorSuppl: primary,
      infoColor: primary,
      infoColorHover: hover,
      infoColorPressed: pressed,
      infoColorSuppl: primary,
      textColorBase: '#e9eaef',
      textColor1: '#e9eaef',
      textColor2: '#a7abb6',
      textColor3: '#7f8592',
      placeholderColor: '#707583',
      borderColor: '#3a3f4e',
      dividerColor: '#242836',
      bodyColor: '#101218',
      cardColor: '#14161d',
      modalColor: '#101218',
      popoverColor: '#1a1d25',
      inputColor: '#171a22',
      hoverColor: '#1c1f28',
      pressedColor: '#262b4a',
      fontFamily,
      borderRadius: '12px',
      borderRadiusSmall: '8px',
      fontSize: '13px',
      heightSmall: '30px',
      heightMedium: '34px'
    }
  }
}

export const INDIGO_ACCENTS = { light: INDIGO_LIGHT, dark: INDIGO_DARK }
