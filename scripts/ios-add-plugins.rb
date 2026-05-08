#!/usr/bin/env ruby
# Adds BLE plugin Swift/ObjC files to the Xcode project after `npx cap add ios`.
require 'xcodeproj'

PROJECT_PATH = 'ios/App/App.xcodeproj'
TARGET_NAME  = 'App'
# Paths relative to the group folder (ios/App/App/)
PLUGIN_FILES = %w[
  BleCentralPlugin.swift
  BleCentralPlugin.m
  BlePeripheralPlugin.swift
  BlePeripheralPlugin.m
].freeze

project = Xcodeproj::Project.open(PROJECT_PATH)
target  = project.targets.find { |t| t.name == TARGET_NAME }
abort "Target '#{TARGET_NAME}' not found in #{PROJECT_PATH}" unless target

# Locate the 'App' group inside the main 'App' group (App > App > *.swift)
app_group = project.main_group
             .children.find { |g| g.respond_to?(:name) && g.name == 'App' }
             &.children&.find { |g| g.respond_to?(:name) && g.name == 'App' }
abort 'Could not locate App/App group in project' unless app_group

added = 0
PLUGIN_FILES.each do |filename|
  already = app_group.files.any? { |f| f.path == filename }
  if already
    puts "  skip  #{filename} (already in project)"
    next
  end

  file_ref = app_group.new_file(filename)
  target.source_build_phase.add_file_reference(file_ref)
  puts "  added #{filename}"
  added += 1
end

project.save
puts "Done — #{added} file(s) added to #{PROJECT_PATH}"
