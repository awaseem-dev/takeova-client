require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'MineStripeTerminal'
  s.version = package['version']
  s.summary = package['description']
  s.license = 'PROPRIETARY'
  s.homepage = 'https://mine.app'
  s.author = 'MINE'
  s.source = { :git => '', :tag => s.version.to_s }
  s.source_files = 'ios/Sources/**/*.{swift,h,m}'
  s.ios.deployment_target = '16.4'  # Tap to Pay requires 16.4+
  s.dependency 'Capacitor'
  s.dependency 'StripeTerminal', '~> 3.0'
  s.swift_version = '5.0'
end
