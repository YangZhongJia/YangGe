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

export const teahouseLightThemeOverrides: GlobalThemeOverrides = {
  ...componentOverrides,
  common: {
    primaryColor: '#5850ec',
    primaryColorHover: '#4f46dc',
    primaryColorPressed: '#4338c9',
    primaryColorSuppl: '#5850ec',
    infoColor: '#5850ec',
    infoColorHover: '#4f46dc',
    infoColorPressed: '#4338c9',
    infoColorSuppl: '#5850ec',
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

export const teahouseDarkThemeOverrides: GlobalThemeOverrides = {
  ...componentOverrides,
  common: {
    primaryColor: '#7b76f0',
    primaryColorHover: '#8d89f5',
    primaryColorPressed: '#6a64e8',
    primaryColorSuppl: '#7b76f0',
    infoColor: '#7b76f0',
    infoColorHover: '#8d89f5',
    infoColorPressed: '#6a64e8',
    infoColorSuppl: '#7b76f0',
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
