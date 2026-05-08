#!/usr/bin/env ruby
# Adds BLE plugin Swift/ObjC files to the Xcode project after `npx cap add ios`.
require 'xcodeproj'

PROJECT_PATH = 'ios/App/App.xcodeproj'
TARGET_NAME  = 'App'
PLUGIN_FILES = %w[
  BleCentralPlugin.swift
  BleCentralPlugin.m
  BlePeripheralPlugin.swift
  BlePeripheralPlugin.m
].freeze

project = Xcodeproj::Project.open(PROJECT_PATH)
target  = project.targets.find { |t| t.name == TARGET_NAME }
abort "Target '#{TARGET_NAME}' not found in #{PROJECT_PATH}" unless target

# Find the group that already contains AppDelegate.swift — that is the app
# sources group regardless of how cap names the hierarchy.
def find_group_with_file(group, filename)
  return group if group.files.any? { |f| f.path == filename }
  group.groups.each do |child|
    result = find_group_with_file(child, filename)
    return result if result
  end
  nil
end

app_group = find_group_with_file(project.main_group, 'AppDelegate.swift')

unless app_group
  # Fallback: print the tree so the next error is actionable
  def print_tree(group, indent = 0)
    prefix = '  ' * indent
    name = group.respond_to?(:name) ? group.name : group.path
    puts "#{prefix}[group] #{name}"
    group.files.each { |f| puts "#{prefix}  #{f.path}" }
    group.groups.each { |g| print_tree(g, indent + 1) }
  end
  puts "=== xcodeproj group tree ==="
  print_tree(project.main_group)
  abort 'Could not locate the app sources group (AppDelegate.swift not found)'
end

puts "Found app group: #{app_group.name || app_group.path}"

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
