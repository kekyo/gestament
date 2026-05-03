project(
  'gestament-gtk3-test-app',
  'cpp',
  default_options: [
    'cpp_std=c++20',
    'warning_level=2',
  ],
)

gtk_dep = dependency('gtk+-3.0')
gestament_include = include_directories('../../include')

executable(
  'gtk3-test-app',
  'src/main.cpp',
  include_directories: gestament_include,
  dependencies: gtk_dep,
)

configure_file(
  input: 'src/main-window.ui',
  output: 'main-window.ui',
  copy: true,
)

configure_file(
  input: 'src/sp_mon.png',
  output: 'sp_mon.png',
  copy: true,
)
