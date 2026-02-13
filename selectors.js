// selectors.js
module.exports = {
  signinUrl: 'https://my.te.eg/echannel/#/home/signin',
  overviewUrl: 'https://my.te.eg/echannel/#/accountoverview',
  usageUrl: 'https://my.te.eg/echannel/#/overview',

  // Sign-in
  inputService: 'input[placeholder*="Service"]',
  selectServiceTypeTrigger: '.ant-select-selector',
  selectDropdownVisible: '.ant-select-dropdown:visible',
  selectServiceTypeOption: '.ant-select-item-option-content',
  inputPassword: '#login_password_input_01',
  loginButton: '#login-withecare',

  // Markers (overview pages)
  markerUsageOverviewText: 'text=Usage Overview',
  markerHomeInternetText: 'text=Home Internet',
  balanceText: 'text=Current Balance',
  remainingText: 'text=Remaining',
  usedText: 'text=Used',
  renewalDateText: 'text=Renewal Date',

  // More details text variants
  moreDetailsTexts: [
    'More Details',
    'Details',
    'مزيد من التفاصيل',
    'تفاصيل',
  ],
};
