module.exports = {
  signinUrl: 'https://my.te.eg/echannel/#/home/signin',
  overviewUrl: 'https://my.te.eg/echannel/#/accountoverview',

  inputService: 'input[placeholder*="Service"]',

  // ant-select
  selectServiceTypeTrigger: '.ant-select-selector',
  // هنفلتر بالـ hasText في الكود بدل selector عام
  selectServiceTypeInternet: '.ant-select-item-option-content',

  inputPassword: '#login_password_input_01',
  loginButton: '#login-withecare',

  markerUsageOverviewText: 'text=/Usage Overview/i',
  markerHomeInternetText: 'text=/Home Internet/i',

  // ✅ بدل span عام: اختار العنصر اللي فيه النص نفسه
  remainingLabel: 'text=/Remaining/i',
  usedLabel: 'text=/Used/i',
  balanceLabel: 'text=/Current Balance/i',

  // More details
  moreDetailsLabel: 'text=/More Details/i',

  renewalTextRegex: 'Renewal\\s*Date',
  renewButtonText: /Renew/i,
  premiumRouterText: /PREMIUM\\s*Router/i
};
